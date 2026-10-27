// Resilience tests: KYA Provider Failure Scenarios
//
// Verifies that the registry Worker degrades gracefully when the external
// KYA provider is unavailable (network error, timeout, non-2xx response).
// In all failure cases, the agent must still register successfully with
// kyaVerificationStatus: "PENDING" — never block registration on KYA.

import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, it, expect } from "vitest";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("KYA provider failure — graceful degradation", () => {
  it("registers agent with PENDING status when KYA provider returns 500", async () => {
    const agentId = `agent-kya500-${Date.now()}`;

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(500, JSON.stringify({ success: false, error: "Internal server error" }), {
        headers: { "Content-Type": "application/json" },
      });

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Resilience Bot" }),
    });

    // Registration must succeed even though KYA failed.
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(agentId);
    expect(json.data.kyaVerificationStatus).toBe("PENDING");
    expect(json.data.kyaProvider).toBe("unavailable");
    // KYA token fields should be absent when verification didn't complete.
    expect(json.data.kyaToken).toBeUndefined();
    expect(json.data.kyaTokenId).toBeUndefined();
  });

  it("persists agent to KV with PENDING status on KYA 500", async () => {
    const agentId = `agent-kv500-${Date.now()}`;

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(500, JSON.stringify({ success: false, error: "Internal server error" }), {
        headers: { "Content-Type": "application/json" },
      });

    await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "KV 500 Bot" }),
    });

    const stored = await env.REGISTRY.get(`agent:${agentId}`, "json") as Record<string, unknown> | null;
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(agentId);
    expect(stored!.kyaVerificationStatus).toBe("PENDING");
    expect(stored!.kyaProvider).toBe("unavailable");
    expect(stored!.kyaToken).toBeUndefined();
  });

  it("registers agent with PENDING status when KYA provider returns 503", async () => {
    const agentId = `agent-kya503-${Date.now()}`;

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(503, "Service Unavailable");

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Service Unavailable Bot" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data.kyaVerificationStatus).toBe("PENDING");
  });

  it("includes a kya_verify span with status error in _trace on KYA failure", async () => {
    const agentId = `agent-trace-err-${Date.now()}`;

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(500, "error");

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Error Trace Bot" }),
    });

    const json = await res.json() as { _trace: Array<{ service: string; op: string; status: string }> };
    const kyaSpan = json._trace.find((t) => t.op === "kya_verify");
    expect(kyaSpan).toBeDefined();
    expect(kyaSpan!.status).toBe("error");
  });

  it("registers agent with PENDING status when KYA provider returns unexpected non-JSON body", async () => {
    const agentId = `agent-badbody-${Date.now()}`;

    // Simulate a response where the body isn't valid JSON — the Worker's json() parse
    // will throw inside the try block, triggering the catch/graceful-degradation path.
    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(200, "not-json-at-all", { headers: { "Content-Type": "text/plain" } });

    const res = await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Bad Body Bot" }),
    });

    // The Worker catches the JSON parse error and degrades gracefully.
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data.kyaVerificationStatus).toBe("PENDING");
    expect(json.data.kyaProvider).toBe("unavailable");
  });
});

describe("KYA provider unavailable — KYA status endpoint still works", () => {
  it("GET /api/agent/:id/kya returns PENDING for agent registered without KYA", async () => {
    const agentId = `agent-pending-kya-${Date.now()}`;

    fetchMock
      .get("https://kya-provider-mock.workers.dev")
      .intercept({ path: "/kya/token", method: "POST" })
      .reply(500, "error");

    await SELF.fetch("https://example.com/api/register/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, name: "Pending KYA Bot" }),
    });

    const kyaRes = await SELF.fetch(`https://example.com/api/agent/${agentId}/kya`);
    expect(kyaRes.status).toBe(200);

    const json = await kyaRes.json() as { data: Record<string, unknown> };
    expect(json.data.kyaVerificationStatus).toBe("PENDING");
    expect(json.data.kyaProvider).toBe("unavailable");
    expect(json.data.kyaToken).toBeUndefined();
  });
});
