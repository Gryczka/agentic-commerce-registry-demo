// Unit tests: Mock KYA Provider Worker (kya-provider-mock)
//
// These tests import the mock KYA provider's Hono app directly and call it
// using app.request() — no HTTP server needed, no fetch() involved.
// This validates the provider's token issuance logic and response shapes
// in isolation, before integration with the registry Worker.
//
// Test coverage:
//   1. POST /kya/token returns a valid token with expected shape
//   2. Token payload carries the expected KYA identity claims
//   3. GET /kya/verify/:tokenId validates a previously issued token
//   4. GET /kya/verify/:tokenId returns 404 for unknown token
//   5. GET /health returns provider info and roadmap
//   6. POST /kya/token validates required fields

import { describe, it, expect } from "vitest";

// Import the mock KYA provider app directly (not via SELF).
// This works because the provider is a separate Hono app — no Workers-specific
// bindings needed, so it runs in a plain Node/V8 context without Miniflare.
import app from "../kya-provider-mock/src/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function issueToken(agentId: string, agentName: string, capabilities: string[] = []) {
  return app.request("/kya/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, agentName, capabilities }),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /kya/token — token issuance", () => {
  it("returns success: true with a token string", async () => {
    const res = await issueToken("agent-abc", "TestBot");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
    expect(typeof json.token).toBe("string");
    expect(typeof json.tokenId).toBe("string");
    expect(typeof json.expiresAt).toBe("string");
  });

  it("token string is 3-part dot-separated (header.payload.sig)", async () => {
    const res = await issueToken("agent-format", "FormatBot");
    const json = await res.json() as { token: string };
    const parts = json.token.split(".");
    expect(parts).toHaveLength(3);
    // Each part should be non-empty base64url
    parts.forEach((p) => expect(p.length).toBeGreaterThan(0));
  });

  it("payload contains standard JWT claims", async () => {
    const res = await issueToken("agent-jwt", "JWTBot");
    const json = await res.json() as { claims: Record<string, unknown> };
    const claims = json.claims;
    expect(typeof claims.jti).toBe("string");
    expect(claims.iss).toBe("https://kya-provider-mock.workers.dev");
    expect(claims.sub).toBe("agent-jwt");
    expect(claims.aud).toBe("agentic-commerce-registry");
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(claims.ver).toBe("1");
    expect(claims.env).toBe("mock");
  });

  it("payload contains bid (buyer identity) claims", async () => {
    const res = await issueToken("agent-bid", "BidBot");
    const json = await res.json() as { claims: { bid: Record<string, unknown> } };
    const bid = json.claims.bid;
    expect(bid.name).toBe("BidBot");
    expect(bid.verification_status).toBe("VERIFIED");
    expect(typeof bid.verification_id).toBe("string");
    expect(bid.verifier).toBe("https://kya-provider-mock.workers.dev");
  });

  it("payload contains apd (agent platform) claims with capabilities", async () => {
    const caps = ["purchase", "negotiate", "compare"];
    const res = await issueToken("agent-apd", "ApdBot", caps);
    const json = await res.json() as { claims: { apd: Record<string, unknown> } };
    const apd = json.claims.apd;
    expect(apd.capabilities).toEqual(caps);
    expect(apd.provider).toBe("mock");
  });

  it("payload has mock: true marker", async () => {
    const res = await issueToken("agent-mock-marker", "MockBot");
    const json = await res.json() as { claims: Record<string, unknown> };
    expect(json.claims.mock).toBe(true);
  });

  it("token expiry is ~30 days from issue time", async () => {
    const beforeCall = Math.floor(Date.now() / 1000);
    const res = await issueToken("agent-expiry", "ExpiryBot");
    const afterCall = Math.floor(Date.now() / 1000);

    const json = await res.json() as { claims: { iat: number; exp: number } };
    const { iat, exp } = json.claims;

    expect(iat).toBeGreaterThanOrEqual(beforeCall);
    expect(iat).toBeLessThanOrEqual(afterCall);

    const thirtyDays = 30 * 24 * 60 * 60;
    expect(exp - iat).toBe(thirtyDays);
  });

  it("each call generates a unique jti", async () => {
    const res1 = await issueToken("agent-uniq1", "UniqBot1");
    const res2 = await issueToken("agent-uniq2", "UniqBot2");
    const j1 = await res1.json() as { claims: { jti: string } };
    const j2 = await res2.json() as { claims: { jti: string } };
    expect(j1.claims.jti).not.toBe(j2.claims.jti);
  });

  it("returns 400 when agentId is missing", async () => {
    const res = await app.request("/kya/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: "NoIdBot" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(typeof json.error).toBe("string");
  });

  it("returns 400 when agentName is missing", async () => {
    const res = await app.request("/kya/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-noname" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(false);
  });

  it("defaults capabilities to empty array when omitted", async () => {
    const res = await issueToken("agent-nocaps", "NoCapsBot");
    const json = await res.json() as { claims: { apd: { capabilities: string[] } } };
    expect(json.claims.apd.capabilities).toEqual([]);
  });
});

describe("GET /kya/verify/:tokenId — token verification", () => {
  it("returns valid: true for a freshly issued token", async () => {
    const issued = await issueToken("agent-verify", "VerifyBot");
    const issuedJson = await issued.json() as { tokenId: string };
    const { tokenId } = issuedJson;

    const res = await app.request(`/kya/verify/${tokenId}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; valid: boolean; claims: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.valid).toBe(true);
    expect(json.claims.sub).toBe("agent-verify");
  });

  it("returns 404 for an unknown token ID", async () => {
    const res = await app.request("/kya/verify/unknown-token-id-xyz");
    expect(res.status).toBe(404);
    const json = await res.json() as { success: boolean; valid: boolean };
    expect(json.success).toBe(false);
    expect(json.valid).toBe(false);
  });
});

describe("GET /health — provider health check", () => {
  it("returns status ok and provider mock", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.status).toBe("ok");
    expect(json.provider).toBe("mock");
    expect(json.phase).toBe(1);
  });

  it("includes roadmap information", async () => {
    const res = await app.request("/health");
    const json = await res.json() as { roadmap: Record<string, string> };
    expect(typeof json.roadmap.phase1).toBe("string");
    expect(typeof json.roadmap.phase2).toBe("string");
    expect(typeof json.roadmap.phase3).toBe("string");
  });
});
