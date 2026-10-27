// Integration tests: Agent Registration + KYA Verification
//
// These tests run inside the Workers runtime via @cloudflare/vitest-pool-workers.
// They use fetchMock (undici MockAgent) to intercept the outbound fetch() call
// that the registry Worker makes to the KYA provider, so tests are fully isolated
// and don't require the mock KYA provider Worker to be deployed.
//
// Test coverage:
//   1. Successful registration stores KYA token in KV and returns VERIFIED status
//   2. Response shape includes all expected KYA fields
//   3. _trace timeline includes a kya_verify span
//   4. GET /api/agent/:id/kya returns stored KYA data
//   5. Registration with a custom agent ID works correctly

import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, it, expect } from "vitest";

// ─── Mock KYA token factory ──────────────────────────────────────────────────
// Produces the same token shape as the real kya-provider-mock Worker.

function makeMockKyaResponse(agentId: string, agentName: string) {
  const jti = `test-jti-${agentId}`;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    jti,
    iss: "https://kya-provider-mock.workers.dev",
    sub: agentId,
    aud: "agentic-commerce-registry",
    iat: now,
    exp: now + 30 * 24 * 60 * 60,
    ver: "1" as const,
    env: "mock" as const,
    bid: {
      name: agentName,
      email: `agent-ops+${agentId}@example.com`,
      verification_status: "VERIFIED",
      verification_id: `verif-${agentId}`,
      verifier: "https://kya-provider-mock.workers.dev",
    },
    apd: {
      capabilities: ["purchase", "negotiate"],
      provider: "mock",
    },
    mock: true as const,
  };
  const encoded = `mockheader.${btoa(JSON.stringify(payload)).replace(/=/g, "")}.mocksig`;
  return {
    success: true,
    token: encoded,
    tokenId: jti,
    claims: payload,
    expiresAt: new Date((now + 30 * 24 * 60 * 60) * 1000).toISOString(),
  };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

beforeAll(() => {
  // Enable fetchMock — intercepts all outbound fetch() calls from the Worker.
  // Without this, the Worker would attempt a real HTTP call to KYA_PROVIDER_URL.
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  // Reset mocks between tests so each test has a clean slate.
  fetchMock.assertNoPendingInterceptors();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/register/agent — successful KYA verification", () => {
  it("returns success with kyaVerificationStatus VERIFIED", async () => {
    const agentId = `shopbot-test-${Date.now()}`;
    const kyaBody = makeMockKyaResponse(agentId, "ShopBot AI");

    // Intercept the outbound fetch() the Worker makes to the KYA provider.
    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(200, JSON.stringify(kyaBody), { headers: { "Content-Type": "application/json" } });

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "ShopBot AI", capabilities: ["purchase", "negotiate"] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);

    const data = json.data as Record<string, unknown>;
    expect(data.id).toBe(agentId);
    expect(data.name).toBe("ShopBot AI");
    expect(data.kyaVerificationStatus).toBe("VERIFIED");
    expect(data.kyaProvider).toBe("mock");
    expect(typeof data.kyaToken).toBe("string");
    expect(typeof data.kyaTokenId).toBe("string");
    expect(typeof data.kyaVerifiedAt).toBe("string");
  });

  it("stores kyaToken and kyaTokenId in Workers KV", async () => {
    const agentId = `shopbot-kv-${Date.now()}`;
    const kyaBody = makeMockKyaResponse(agentId, "KV Test Bot");

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(200, JSON.stringify(kyaBody), { headers: { "Content-Type": "application/json" } });

    await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "KV Test Bot" }),
    });

    // Directly read the KV record to verify KYA fields were persisted.
    const stored = await env.REGISTRY.get(`agent:${agentId}`, "json") as Record<string, unknown> | null;
    expect(stored).not.toBeNull();
    expect(stored!.kyaVerificationStatus).toBe("VERIFIED");
    expect(stored!.kyaToken).toBe(kyaBody.token);
    expect(stored!.kyaTokenId).toBe(kyaBody.tokenId);
    expect(stored!.kyaProvider).toBe("mock");
  });

  it("includes a kya_verify span in the _trace timeline", async () => {
    const agentId = `shopbot-trace-${Date.now()}`;
    const kyaBody = makeMockKyaResponse(agentId, "Trace Bot");

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(200, JSON.stringify(kyaBody), { headers: { "Content-Type": "application/json" } });

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Trace Bot" }),
    });

    const json = await res.json() as { _trace: Array<{ service: string; op: string; status: string }> };
    const kyaSpan = json._trace.find((t) => t.op === "kya_verify");
    expect(kyaSpan).toBeDefined();
    expect(kyaSpan!.service).toBe("worker");
    expect(kyaSpan!.status).toBe("ok");
  });

  it("returns _colo field in response", async () => {
    const agentId = `shopbot-colo-${Date.now()}`;
    const kyaBody = makeMockKyaResponse(agentId, "Colo Bot");

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(200, JSON.stringify(kyaBody), { headers: { "Content-Type": "application/json" } });

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Colo Bot" }),
    });

    const json = await res.json() as Record<string, unknown>;
    // In tests (Miniflare), _colo may be null or a string — just verify the key exists.
    expect("_colo" in json).toBe(true);
  });
});

describe("GET /api/agent/:id/kya — KYA status retrieval", () => {
  it("returns KYA fields for a registered agent", async () => {
    const agentId = `shopbot-getkya-${Date.now()}`;
    const kyaBody = makeMockKyaResponse(agentId, "GetKYA Bot");

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(200, JSON.stringify(kyaBody), { headers: { "Content-Type": "application/json" } });

    // Register the agent first.
    await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "GetKYA Bot" }),
    });

    // Now fetch KYA status via the dedicated endpoint.
    const kyaRes = await SELF.fetch(`https://example.com/api/agent/${agentId}/kya`);
    expect(kyaRes.status).toBe(200);

    const json = await kyaRes.json() as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data.agentId).toBe(agentId);
    expect(json.data.kyaVerificationStatus).toBe("VERIFIED");
    expect(json.data.kyaToken).toBe(kyaBody.token);
    expect(json.data.kyaTokenId).toBe(kyaBody.tokenId);
  });

  it("returns 404 for a non-existent agent", async () => {
    const res = await SELF.fetch("https://example.com/api/agent/does-not-exist/kya");
    expect(res.status).toBe(404);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(false);
  });
});

describe("POST /api/register/agent — field validation", () => {
  it("rejects a request missing the name field", async () => {
    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent-no-name", capabilities: ["purchase"] }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(false);
  });
});
