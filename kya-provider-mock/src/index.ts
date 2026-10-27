// KYA Provider Mock — Cloudflare Worker
// A standalone deployable Worker that acts as a mock KYA (Know Your Agent)
// identity verification service. It issues signed-style KYA tokens with
// JWT-style identity claims.
//
// This is Phase 1 of a three-phase roadmap:
//   Phase 1: This mock Worker â called over HTTP fetch(), no bindings
//   Phase 2: AWS Lambda function — same API contract, cross-cloud
//   Phase 3: Hosted KYA provider API — production tokens (requires API key)
//
// The token format is 3-part dot-separated (looks like a JWT):
//   <base64url(header)>.<base64url(payload)>.<mock-signature>
// The payload uses stable identity claims so the registry Worker's
// consumption logic won't need to change when swapping in a real provider.

// [Hono] Hono — lightweight web framework for Cloudflare Workers.
import { Hono } from "hono";
// [Hono] CORS middleware — allows the registry Worker to call this service.
import { cors } from "hono/cors";

// ─── KYA Token Types ──────────────────────────────────────────────────────────
// Identity claims carried by every KYA token.

export interface KyaTokenHeader {
  alg: "mock" | "ES256";    // "mock" for this provider; "ES256" for a signing provider
  kid: string;               // key ID
  typ: "kya+JWT";            // token type
}

export interface KyaTokenPayload {
  // Standard JWT claims
  jti: string;               // unique token ID (UUID)
  iss: string;               // issuer URL
  sub: string;               // agent ID (the entity being verified)
  aud: string;               // audience — the registry service
  iat: number;               // issued at (epoch seconds)
  exp: number;               // expiry (epoch seconds) — 30 days from issue
  // KYA token claims
  ver: "1";                  // schema version
  env: "mock" | "sandbox" | "production";
  // Agent identity claims (bid = buyer identity)
  bid: {
    name: string;            // agent display name
    email: string;           // contact email for the agent operator
    verification_status: "VERIFIED" | "PENDING" | "FAILED";
    verification_id: string; // this provider's verification record ID
    verifier: string;        // URL of this verification provider
  };
  // Agent platform/capabilities claims (apd = agent platform data)
  apd: {
    capabilities: string[];  // declared agent capabilities
    provider: string;        // KYA provider identifier
  };
  // Mock-specific marker — removed when swapping in a real provider
  mock: true;
}

export interface KyaToken {
  header: KyaTokenHeader;
  payload: KyaTokenPayload;
  // Full encoded token string: <header>.<payload>.<signature>
  encoded: string;
}

// ─── Token Store ──────────────────────────────────────────────────────────────
// In-memory store for issued tokens (resets on Worker cold start).
// A real KYA provider would persist these to a database.

const issuedTokens = new Map<string, KyaTokenPayload>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// [Workers] btoa() is available natively in the Workers runtime.
// We use URL-safe base64 (base64url) to match JWT conventions.
function base64url(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// Mock signature: deterministic HMAC-shaped string for display purposes only.
// A real provider would sign with a private key (ES256).
function mockSignature(jti: string): string {
  return btoa(`mock-sig:${jti}`).replace(/=/g, "");
}

function encodeToken(header: KyaTokenHeader, payload: KyaTokenPayload): string {
  return `${base64url(header)}.${base64url(payload)}.${mockSignature(payload.jti)}`;
}

// ─── App ──────────────────────────────────────────────────────────────────────

// [Hono] Create the Hono app. No bindings needed — this provider is stateless
// (uses in-memory token store; a production version would use KV or D1).
const app = new Hono();

// [Hono] Apply CORS so the registry Worker and browsers can call this API.
app.use("/kya/*", cors());
app.use("/health", cors());

// ─── Health Check ─────────────────────────────────────────────────────────────

// [Hono] Simple health endpoint so the registry Worker can check availability.
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    provider: "mock",
    phase: 1,
    description: "Mock KYA provider — Phase 1 of the KYA provider roadmap",
    roadmap: {
      phase1: "Mock Cloudflare Worker (current)",
      phase2: "AWS Lambda (same API contract)",
      phase3: "Hosted KYA provider API (real KYA tokens)",
    },
  });
});

// ─── Issue KYA Token ──────────────────────────────────────────────────────────
// POST /kya/token
// Accepts agent registration details, performs mock KYA verification,
// and returns a signed-style KYA identity token.

app.post("/kya/token", async (c) => {
  // [Hono] Parse the incoming JSON body from the registry Worker.
  let body: { agentId: string; agentName: string; capabilities?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { agentId, agentName, capabilities = [] } = body;

  if (!agentId || typeof agentId !== "string") {
    return c.json({ success: false, error: "agentId is required (string)" }, 400);
  }
  if (!agentName || typeof agentName !== "string") {
    return c.json({ success: false, error: "agentName is required (string)" }, 400);
  }

  // [Workers] Use Web Crypto to generate cryptographically random UUIDs
  // for the token ID and verification record ID.
  const jti = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const thirtyDays = 30 * 24 * 60 * 60;

  // [Agentic Commerce Registry] Build the KYA token header .
  const header: KyaTokenHeader = {
    alg: "mock",
    kid: "mock-key-1",
    typ: "kya+JWT",
  };

  // [Agentic Commerce Registry] Build the KYA token payload with agent identity claims.
  // bid (buyer identity) and apd (agent platform data) are the provider-neutral identity claims.
  const payload: KyaTokenPayload = {
    jti,
    iss: "https://kya-provider-mock.workers.dev",
    sub: agentId,
    aud: "agentic-commerce-registry",
    iat: now,
    exp: now + thirtyDays,
    ver: "1",
    env: "mock",
    bid: {
      name: agentName,
      email: `agent-ops+${agentId}@example.com`,
      verification_status: "VERIFIED",
      verification_id: verificationId,
      verifier: "https://kya-provider-mock.workers.dev",
    },
    apd: {
      capabilities,
      provider: "mock",
    },
    mock: true,
  };

  const encoded = encodeToken(header, payload);

  // Store in memory so /kya/verify/:tokenId can look it up.
  issuedTokens.set(jti, payload);

  return c.json({
    success: true,
    token: encoded,
    tokenId: jti,
    claims: payload,
    expiresAt: new Date((now + thirtyDays) * 1000).toISOString(),
  });
});

// ─── Verify KYA Token ─────────────────────────────────────────────────────────
// GET /kya/verify/:tokenId
// Validates a previously issued KYA token by its jti (token ID).
// Returns the token claims if valid.

app.get("/kya/verify/:tokenId", (c) => {
  const tokenId = c.req.param("tokenId");
  const payload = issuedTokens.get(tokenId);

  if (!payload) {
    return c.json({
      success: false,
      valid: false,
      error: "Token not found — either invalid or issued before this Worker instance started",
    }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return c.json({
      success: false,
      valid: false,
      error: "Token expired",
      expiredAt: new Date(payload.exp * 1000).toISOString(),
    }, 410);
  }

  return c.json({
    success: true,
    valid: true,
    claims: payload,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  });
});

// [Workers] Export the Hono app as the default export — this is the Workers
// module format entry point.
export default app;
