import { DurableObject } from 'cloudflare:workers';

export interface Scope { owner: string; generation: number; expiresAt: number }
type AuthorityEnv = CloudflareBindings;

/** Invalid configured limits fail closed; absent settings use conservative defaults. */
export function limit(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error('Invalid demo budget configuration');
  return parsed;
}

/** One bounded coordinator enforces cross-colo allowances, not per-colo approximations. */
export class CommerceAuthority extends DurableObject<AuthorityEnv> {
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (owner TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_owner ON records(owner);
      CREATE TABLE IF NOT EXISTS allowances (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    `);
  }

  private prune(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM sessions WHERE expiresAt <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM records WHERE expiresAt <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM allowances WHERE expiresAt <= ?', now);
  }

  private take(key: string, maximum: number, period: number): boolean {
    const window = Math.floor(Date.now() / period);
    const id = `${key}:${window}`;
    const count = this.ctx.storage.sql.exec<{ count: number }>('SELECT count FROM allowances WHERE key = ?', id).toArray()[0]?.count ?? 0;
    if (count >= maximum) return false;
    this.ctx.storage.sql.exec('INSERT INTO allowances VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1', id, (window + 1) * period);
    return true;
  }

  async create(owner: string, ipHash: string): Promise<Scope | null> {
    this.prune();
    const ttl = limit(this.env.SESSION_TTL_SECONDS, 7200, 86400);
    const result = this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').one().n >= limit(this.env.MAX_SESSIONS, 100, 1000)) return null;
      // Consume the global allowance first, bounding even rejected IP-counter cardinality.
      if (!this.take('new-session', limit(this.env.NEW_SESSIONS_PER_HOUR, 20, 1000), 3600000)) return null;
      if (!this.take(`new-session:${ipHash}`, 3, 3600000)) return null;
      const expiresAt = Date.now() + ttl * 1000;
      this.ctx.storage.sql.exec('INSERT INTO sessions(owner, expiresAt) VALUES (?, ?)', owner, expiresAt);
      return { owner, generation: 0, expiresAt };
    });
    await this.ctx.storage.setAlarm(Date.now() + 3600000);
    return result;
  }

  async authorize(owner: string, consume = true): Promise<Scope | null> {
    this.prune();
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<Scope & Record<string, SqlStorageValue>>('SELECT * FROM sessions WHERE owner = ?', owner).toArray()[0];
      // KV requires at least 60 seconds of TTL. Do not extend records past session expiry.
      if (!row || row.expiresAt <= Date.now() + 60000) return null;
      if (consume && (!this.take('actions:day', limit(this.env.GLOBAL_ACTIONS_PER_DAY, 1000, 10000), 86400000) ||
        !this.take('actions:minute', limit(this.env.GLOBAL_ACTIONS_PER_MINUTE, 120, 1000), 60000) ||
        !this.take(`actions:${owner}`, limit(this.env.SESSION_ACTIONS_PER_MINUTE, 30, 120), 60000))) return null;
      return { owner: row.owner, generation: row.generation, expiresAt: row.expiresAt };
    });
  }

  async reserve(scope: Scope, keys: string[]): Promise<boolean> {
    this.prune();
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ generation: number; expiresAt: number }>('SELECT generation, expiresAt FROM sessions WHERE owner = ?', scope.owner).toArray()[0];
      if (!row || row.generation !== scope.generation || row.expiresAt !== scope.expiresAt || row.expiresAt <= Date.now() + 60000 || keys.length > 2) return false;
      if (keys.some(key => !key.startsWith(`session:${scope.owner}:${scope.generation}:`))) return false;
      const fresh = [...new Set(keys)].filter(key => !this.ctx.storage.sql.exec('SELECT key FROM records WHERE key = ?', key).toArray().length);
      const global = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM records').one().n;
      const owned = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM records WHERE owner = ?', scope.owner).one().n;
      if (global + fresh.length > limit(this.env.MAX_RECORDS, 5000, 10000) || owned + fresh.length > limit(this.env.MAX_SESSION_RECORDS, 100, 500)) return false;
      for (const key of fresh) this.ctx.storage.sql.exec('INSERT INTO records VALUES (?, ?, ?)', key, scope.owner, row.expiresAt);
      return true;
    });
  }

  async reset(scope: Scope): Promise<string[]> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ generation: number }>('SELECT generation FROM sessions WHERE owner = ?', scope.owner).toArray()[0];
      if (!row || row.generation !== scope.generation) return [];
      const keys = this.ctx.storage.sql.exec<{ key: string }>('SELECT key FROM records WHERE owner = ?', scope.owner).toArray().map(row => row.key);
      // Rotate the namespace first: in-flight writes to the previous epoch become inaccessible.
      this.ctx.storage.sql.exec('UPDATE sessions SET generation = generation + 1 WHERE owner = ?', scope.owner);
      // Keep reservations until TTL even after deletion: a write already awaiting
      // KV may finish after reset. Releasing its slot would undercount retained KV.
      return keys;
    });
  }

  async maintenance(): Promise<boolean> {
    this.prune();
    return this.take('maintenance', 10, 3600000);
  }

  async alarm(): Promise<void> {
    this.prune();
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sessions').one().n;
    const remaining = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM allowances').one().n;
    if (count || remaining) await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
}
