import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { putReservedRecord } from '../src/production';

const origin = 'https://example.com';
async function post(path: string, cookie = '', body?: unknown) {
  return SELF.fetch(`${origin}/api/${path}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function session() {
  const response = await post('session');
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}
describe('production ownership and budgets', () => {
  it('keeps absolute KV expiry through delayed writes, reset and storage failure', async () => {
    const coordinator = env.AUTHORITY.getByName(`delay-${crypto.randomUUID()}`);
    const scope = (await coordinator.create('owner', 'ip'))!;
    const ownedKey = 'session:owner:0:agent:delayed';
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const options: KVNamespacePutOptions[] = [];
    const kv = { put: vi.fn(async (_key: string, _value: string | ArrayBuffer | ArrayBufferView | ReadableStream, option?: KVNamespacePutOptions) => {
      now += 90_000;
      options.push(option!);
      await coordinator.reset(scope);
    }) };
    try {
      await putReservedRecord(kv, coordinator, scope, ownedKey, { id: 'delayed' });
      expect(options[0]).toEqual({ expiration: Math.floor(scope.expiresAt / 1000) });
      await runInDurableObject(coordinator, (_instance, state) => {
        expect(state.storage.sql.exec<{ expiresAt: number }>('SELECT expiresAt FROM records WHERE key = ?', ownedKey).one().expiresAt).toBe(scope.expiresAt);
      });
      expect(await coordinator.reserve(scope, [ownedKey])).toBe(false);
      const current = (await coordinator.authorize('owner', false))!;
      const failed = 'session:owner:1:agent:failed';
      kv.put.mockImplementationOnce(async () => { throw new Error('injected KV failure'); });
      await expect(putReservedRecord(kv, coordinator, current, failed, { id: 'failed' })).rejects.toThrow('injected KV failure');
      await runInDurableObject(coordinator, (_instance, state) => expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM records').one().n).toBe(2));
    } finally { clock.mockRestore(); }
  });
  it('rejects short future expirations after delayed reservation without invoking KV', async () => {
    const base = Date.now();
    let now = base;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const kv = { put: vi.fn(async () => undefined) };
    const reserve = vi.fn(async () => { now = base + 61_000; return true; });
    try {
      await expect(putReservedRecord(kv, { reserve }, { owner: 'owner', generation: 0, expiresAt: base + 120_000 }, 'session:owner:0:agent:a', {})).rejects.toThrow('Session expired');
      expect(kv.put).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('isolates identical caller IDs, tokens, completion and reset across sessions', async () => {
    const a = await session(), b = await session();
    for (const [kind, value] of [['shopper', { id: 'shopper', name: 'A', email: 'a@example.com' }], ['agent', { id: 'agent', name: 'Agent' }], ['merchant', { id: 'merchant', name: 'Merchant' }]] as const) {
      expect((await post(`register/${kind}`, a, value)).status).toBe(200);
    }
    expect((await post('delegate', b, { shopperId: 'shopper', agentId: 'agent' })).status).toBe(404);
    const delegation = await (await post('delegate', a, { shopperId: 'shopper', agentId: 'agent' })).json() as any;
    const token = delegation.data.delegation.token;
    expect((await post('verify', b, { token })).status).toBe(401);
    const initiation = await (await post('transaction/initiate', a, { token, merchantId: 'merchant', amount: 100 })).json() as any;
    expect((await post('transaction/complete', b, { transactionId: initiation.data.transaction.id })).status).toBe(404);
    expect((await post('reset', b)).status).toBe(200);
    expect((await post('verify', a, { token })).status).toBe(200);
    expect((await post('reset', a)).status).toBe(200);
    expect((await post('verify', a, { token })).status).toBe(401);
  });
  it('rejects anonymous reset, cross-origin writes, local-only KYA and operator access', async () => {
    expect((await post('reset')).status).toBe(401);
    expect((await SELF.fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: 'https://other.example' } })).status).toBe(403);
    expect((await post('operator/reset', '', { prefix: 'session:' })).status).toBe(403);
    expect((await SELF.fetch(`${origin}/api/agent/id/kya`)).status).toBeGreaterThanOrEqual(400);
  });
  it('bounds streamed bytes, actions and reservations across reset epochs', async () => {
    const cookie = await session();
    const oversized = await SELF.fetch(`${origin}/api/register/agent`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: ' '.repeat(16385) });
    expect(oversized.status).toBe(400);
    const authority = env.AUTHORITY.getByName('budget-test');
    const scope = await authority.create('owner', 'ip');
    expect(scope).not.toBeNull();
    const key = 'session:owner:0:agent:a';
    expect(await authority.reserve(scope!, [key])).toBe(true);
    await authority.reset(scope!);
    expect(await authority.reserve(scope!, [key])).toBe(false);
    await runInDurableObject(authority, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM records').one().n).toBe(1);
    });
    for (let i = 0; i < 30; i++) expect(await authority.authorize('owner')).not.toBeNull();
    expect(await authority.authorize('owner')).toBeNull();
  });
});
