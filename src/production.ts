/** Hardened production baseline: registration/delegation/transactions, without local-only KYA or AI/MCP features. */
import { Hono } from 'hono';
import { CommerceAuthority, type Scope } from './authority';
export { CommerceAuthority };

type Bindings = CloudflareBindings & { REGISTRY_OPERATOR_TOKEN?: string };
type RecordValue = Record<string, unknown>;
const app = new Hono<{ Bindings: Bindings; Variables: { scope: Scope } }>();
const routes = new Set(['/api/reset', '/api/register/shopper', '/api/register/merchant', '/api/register/agent', '/api/delegate', '/api/verify', '/api/transaction/initiate', '/api/transaction/complete']);

export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function token(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }
function authority(env: Bindings) { return (env.AUTHORITY as DurableObjectNamespace<CommerceAuthority>).getByName('global'); }
function cookieName(url: URL) { return url.protocol === 'https:' ? '__Host-commerce_session' : 'commerce_session'; }
function sessionCookie(request: Request): string | null {
  const name = cookieName(new URL(request.url));
  const value = request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function sameOrigin(request: Request): boolean { return request.headers.get('Origin') === new URL(request.url).origin; }
function key(scope: Scope, name: string): string { return `session:${scope.owner}:${scope.generation}:${name}`; }
function text(value: unknown, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('Invalid text field');
  return value.trim();
}
function number(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < minimum || result > maximum) throw new Error('Invalid number field');
  return result;
}
function strings(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 10) throw new Error('Invalid list field');
  return value.map(item => text(item, 64));
}
async function body(request: Request): Promise<RecordValue> {
  if (!request.headers.get('Content-Type')?.includes('application/json') || !request.body) throw new Error('Expected JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('Request exceeds 16 KiB'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected JSON object');
  return result as RecordValue;
}

/** Reservations remain conservative even when a put fails or completes after reset. */
export async function putReservedRecord(kv: Pick<KVNamespace, 'put'>, coordinator: Pick<DurableObjectStub<CommerceAuthority>, 'reserve'>, scope: Scope, scopedKey: string, value: RecordValue): Promise<void> {
  if (!await coordinator.reserve(scope, [scopedKey])) throw new Error('Retained-record allowance exhausted or session reset');
  const expiration = Math.floor(scope.expiresAt / 1000);
  if (!Number.isSafeInteger(expiration) || expiration < Math.ceil(Date.now() / 1000) + 60) throw new Error('Session expired');
  // Relative TTL would restart when a delayed write reaches KV. This deadline cannot move.
  await kv.put(scopedKey, JSON.stringify(value), { expiration });
}

class OwnedKV {
  readonly traces: { service: string; op: string; duration_ms: number; status: string }[] = [];
  constructor(private env: Bindings, private scope: Scope) {}
  async get<T extends RecordValue>(name: string): Promise<T | null> {
    const start = Date.now();
    const value = await this.env.REGISTRY.get<T>(key(this.scope, name), 'json');
    this.traces.push({ service: 'kv', op: `GET ${name.split(':')[0]}`, duration_ms: Date.now() - start, status: 'ok' });
    return value;
  }
  async put(name: string, value: RecordValue): Promise<void> {
    const scopedKey = key(this.scope, name);
    const start = Date.now();
    await putReservedRecord(this.env.REGISTRY, authority(this.env), this.scope, scopedKey, value);
    this.traces.push({ service: 'kv', op: `PUT ${name.split(':')[0]}`, duration_ms: Date.now() - start, status: 'ok' });
  }
}

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer'); c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.path === '/api/operator/reset') return next();
  if (c.req.method !== 'POST' || !sameOrigin(c.req.raw)) return c.json({ success: false, error: 'Same-origin POST required' }, 403);
  if (c.req.path === '/api/session') return next();
  if (!routes.has(c.req.path)) return c.json({ success: false, error: 'Not found' }, 404);
  const presented = sessionCookie(c.req.raw);
  if (!presented) return c.json({ success: false, error: 'Start a demo session first' }, 401);
  const owner = await digest(presented);
  if (!await authority(c.env).authorize(owner, false)) return c.json({ success: false, error: 'Session expired' }, 401);
  const scope = await authority(c.env).authorize(owner);
  if (!scope) return c.json({ success: false, error: 'Demo action allowance exhausted; try later' }, 429);
  c.set('scope', scope);
  await next();
});

app.post('/api/session', async c => {
  const url = new URL(c.req.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return c.json({ success: false, error: 'HTTPS required' }, 403);
  const existing = sessionCookie(c.req.raw);
  if (existing) {
    const scope = await authority(c.env).authorize(await digest(existing), false);
    if (scope) return c.json({ success: true, expiresAt: scope.expiresAt });
  }
  const value = token();
  const scope = await authority(c.env).create(await digest(value), await digest(c.req.header('CF-Connecting-IP') ?? 'local'));
  if (!scope) return c.json({ success: false, error: 'Session admission allowance exhausted' }, 429);
  c.header('Set-Cookie', `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((scope.expiresAt - Date.now()) / 1000)}${url.protocol === 'https:' ? '; Secure' : ''}`);
  return c.json({ success: true, expiresAt: scope.expiresAt });
});

app.post('/api/reset', async c => {
  const keys = await authority(c.env).reset(c.get('scope'));
  for (const owned of keys) await c.env.REGISTRY.delete(owned);
  return c.json({ success: true, message: 'Your session data cleared', _trace: [], _colo: c.req.raw.cf?.colo ?? 'local' });
});

app.post('/api/operator/reset', async c => {
  const expected = c.env.REGISTRY_OPERATOR_TOKEN;
  const supplied = c.req.header('Authorization')?.replace(/^Bearer /, '');
  if (!expected || !supplied) return c.json({ success: false, error: 'Operator authorization required' }, 403);
  const [a, b] = await Promise.all([digest(expected), digest(supplied)]);
  let difference = 0; for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  if (difference) return c.json({ success: false, error: 'Operator authorization required' }, 403);
  if (!await authority(c.env).maintenance()) return c.json({ success: false, error: 'Maintenance allowance exhausted' }, 429);
  const input = await body(c.req.raw);
  const prefix = text(input.prefix, 24);
  if (!['shopper:', 'merchant:', 'agent:', 'delegation:', 'token:', 'transaction:', 'session:'].includes(prefix)) return c.json({ success: false, error: 'Unknown maintenance prefix' }, 400);
  const list = await c.env.REGISTRY.list({ prefix, limit: 100, ...(typeof input.cursor === 'string' ? { cursor: text(input.cursor, 2048) } : {}) });
  for (const record of list.keys) await c.env.REGISTRY.delete(record.name);
  return c.json({ success: true, deleted: list.keys.length, cursor: list.list_complete ? null : list.cursor });
});

for (const kind of ['shopper', 'merchant', 'agent'] as const) {
  app.post(`/api/register/${kind}`, async c => {
    const input = await body(c.req.raw); const name = text(input.name);
    const id = input.id === undefined ? `${kind}-${crypto.randomUUID()}` : text(input.id, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid record ID');
    const kv = new OwnedKV(c.env, c.get('scope'));
    const record: RecordValue = { id, name, registeredAt: new Date().toISOString() };
    if (kind === 'shopper') Object.assign(record, { email: text(input.email), creditScore: number(input.creditScore, 750, 850), creditLimit: number(input.creditLimit, 10000, 1000000) });
    if (kind === 'merchant') {
      if (['acceptsLoans', 'acceptsLeases'].some(field => input[field] !== undefined && typeof input[field] !== 'boolean')) throw new Error('Invalid merchant capability');
      Object.assign(record, { businessType: input.businessType === undefined ? 'retail' : text(input.businessType), acceptsLoans: input.acceptsLoans ?? true, acceptsLeases: input.acceptsLeases ?? true });
    }
    if (kind === 'agent') record.capabilities = strings(input.capabilities, ['purchase', 'negotiate']);
    await kv.put(`${kind}:${id}`, record);
    return c.json({ success: true, data: record, _trace: kv.traces, _colo: c.req.raw.cf?.colo ?? 'local' });
  });
}

app.post('/api/delegate', async c => {
  const input = await body(c.req.raw); const kv = new OwnedKV(c.env, c.get('scope'));
  const shopperId = text(input.shopperId, 64), agentId = text(input.agentId, 64);
  const [shopper, agent] = await Promise.all([kv.get(`shopper:${shopperId}`), kv.get(`agent:${agentId}`)]);
  if (!shopper || !agent) return c.json({ success: false, error: 'Owned shopper and agent required' }, 404);
  const value = token(); const expiresAt = new Date(c.get('scope').expiresAt).toISOString();
  const delegation = { shopperId, agentId, token: value, scope: strings(input.scope, ['purchase']), maxAmount: number(input.maxAmount, 5000, 1000000), allowedTransactionTypes: strings(input.allowedTransactionTypes, ['loan', 'lease']), expiresAt, createdAt: new Date().toISOString() };
  await kv.put(`delegation:${agentId}:${shopperId}`, delegation);
  await kv.put(`token:${value}`, delegation);
  return c.json({ success: true, data: { delegation: { ...delegation, shopperName: shopper.name, agentName: agent.name } }, _trace: kv.traces, _colo: c.req.raw.cf?.colo ?? 'local' });
});

app.post('/api/verify', async c => {
  const input = await body(c.req.raw); const kv = new OwnedKV(c.env, c.get('scope'));
  const delegation = await kv.get(`token:${text(input.token, 64)}`);
  if (!delegation || Date.parse(String(delegation.expiresAt)) <= Date.now()) return c.json({ success: false, verified: false, error: 'Invalid owned delegation' }, 401);
  const shopper = await kv.get(`shopper:${delegation.shopperId}`);
  return c.json({ success: true, verified: true, data: { ...delegation, token: undefined, shopperName: shopper?.name, shopperCreditScore: shopper?.creditScore, shopperCreditLimit: shopper?.creditLimit }, _trace: kv.traces, _colo: c.req.raw.cf?.colo ?? 'local' });
});

app.post('/api/transaction/initiate', async c => {
  const input = await body(c.req.raw); const kv = new OwnedKV(c.env, c.get('scope'));
  const delegation = await kv.get(`token:${text(input.token, 64)}`);
  if (!delegation || Date.parse(String(delegation.expiresAt)) <= Date.now()) return c.json({ success: false, error: 'Invalid owned delegation' }, 401);
  const amount = number(input.amount, 0, 1000000, 0.01), type = input.type === undefined ? 'lease' : text(input.type, 16);
  if (!(delegation.allowedTransactionTypes as string[]).includes(type) || !(delegation.scope as string[]).includes('purchase') || amount > Number(delegation.maxAmount)) return c.json({ success: false, error: 'Delegation constraints exceeded' }, 403);
  const merchantId = text(input.merchantId, 64);
  const [merchant, shopper] = await Promise.all([kv.get(`merchant:${merchantId}`), kv.get(`shopper:${delegation.shopperId}`)]);
  if (!merchant || !shopper) return c.json({ success: false, error: 'Owned merchant and shopper required' }, 404);
  if ((type === 'loan' && !merchant.acceptsLoans) || (type === 'lease' && !merchant.acceptsLeases) || amount > Number(shopper.creditLimit)) return c.json({ success: false, error: 'Merchant or credit constraints exceeded' }, 403);
  const termMonths = number(input.termMonths, 12, 60, 1);
  if (!Number.isInteger(termMonths)) throw new Error('Term must be a whole number of months');
  const transaction = { id: `tx-${crypto.randomUUID()}`, agentId: delegation.agentId, shopperId: delegation.shopperId, merchantId, type, itemDescription: input.itemDescription === undefined ? 'Item' : text(input.itemDescription, 500), amount, termMonths, monthlyPayment: Math.round(amount / termMonths * 100) / 100, status: 'initiated', createdAt: new Date().toISOString() };
  await kv.put(`transaction:${transaction.id}`, transaction);
  return c.json({ success: true, data: { transaction, shopperName: shopper.name, merchantName: merchant.name }, _trace: kv.traces, _colo: c.req.raw.cf?.colo ?? 'local' });
});

app.post('/api/transaction/complete', async c => {
  const input = await body(c.req.raw); const kv = new OwnedKV(c.env, c.get('scope'));
  const transaction = await kv.get(`transaction:${text(input.transactionId, 64)}`);
  if (!transaction) return c.json({ success: false, error: 'Owned transaction required' }, 404);
  transaction.status = 'completed'; transaction.completedAt ??= new Date().toISOString();
  await kv.put(`transaction:${transaction.id}`, transaction);
  const [shopper, merchant, agent] = await Promise.all([kv.get(`shopper:${transaction.shopperId}`), kv.get(`merchant:${transaction.merchantId}`), kv.get(`agent:${transaction.agentId}`)]);
  return c.json({ success: true, data: { transaction, summary: { shopper: shopper?.name, merchant: merchant?.name, agent: agent?.name, item: transaction.itemDescription, type: transaction.type, amount: `$${transaction.amount}`, term: `${transaction.termMonths} months`, monthlyPayment: `$${transaction.monthlyPayment}`, status: transaction.status } }, _trace: kv.traces, _colo: c.req.raw.cf?.colo ?? 'local' });
});

app.onError((error, c) => {
  // Configuration/storage failures fail closed and never expose provider error details.
  const validation = /Invalid |Expected |Request exceeds|Term must/.test(error.message);
  const budget = /allowance exhausted|Session expired/.test(error.message);
  return c.json({ success: false, error: validation ? error.message : budget ? 'Demo allowance exhausted or session expired' : 'Demo temporarily unavailable' }, validation ? 400 : budget ? 429 : 503);
});
app.all('/api/*', c => c.json({ success: false, error: 'Not found' }, 404));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
export default app;
