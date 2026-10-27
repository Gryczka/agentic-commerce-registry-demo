// Agentic Commerce Registry — Cloudflare Worker
// A Cloudflare Worker is server-side code that runs on Cloudflare's global edge network.
// This Worker uses Hono (a lightweight web framework built for Workers) for routing,
// and Workers KV (a globally distributed key-value store) for persistence.
// It implements an identity registry for shoppers, merchants, and AI agents.

// [Hono] Import Hono — a fast, lightweight web framework designed for Cloudflare Workers.
// Hono provides routing, request parsing, and response helpers similar to Express.
import { Hono } from "hono";
// [Hono] CORS middleware — allows cross-origin requests to the API endpoints.
import { cors } from "hono/cors";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TraceEntry {
  service: string;
  op: string;
  duration_ms: number;
  status: "ok" | "error";
}

// [Agentic Commerce Registry] Domain types for the three participant identities.

interface Shopper {
  id: string;
  name: string;
  email: string;
  creditScore: number;
  creditLimit: number;
  registeredAt: string;
}

interface Merchant {
  id: string;
  name: string;
  businessType: string;
  acceptsLoans: boolean;
  acceptsLeases: boolean;
  registeredAt: string;
}

// [Agentic Commerce Registry] KYA (Know Your Agent) verification status.
// Mirrors the verification_status claim carried in the provider's KYA token.
type KyaVerificationStatus = "VERIFIED" | "PENDING" | "FAILED";

interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  registeredAt: string;
  // KYA identity verification fields — populated by the external KYA provider.
  // If the KYA provider is unreachable, kyaVerificationStatus is "PENDING"
  // and the agent is still registered (graceful degradation).
  kyaToken?: string;                  // encoded KYA token (base64url header.payload.sig)
  kyaTokenId?: string;                // jti claim — use for /kya/verify/:tokenId lookup
  kyaVerificationStatus?: KyaVerificationStatus;
  kyaProvider?: string;               // "mock" | "lambda" | "hosted" | "unavailable"
  kyaVerifiedAt?: string;             // ISO timestamp when verification completed
}

// [Agentic Commerce Registry] A delegation grants an AI agent limited authority to act on a shopper's behalf.

interface Delegation {
  agentId: string;
  shopperId: string;
  scope: string[];
  maxAmount: number;
  allowedTransactionTypes: string[];
  token: string;
  expiresAt: string;
  createdAt: string;
}

// [Agentic Commerce Registry] A transaction records a purchase initiated by an agent on behalf of a shopper.

interface Transaction {
  id: string;
  agentId: string;
  shopperId: string;
  merchantId: string;
  type: string;
  itemDescription: string;
  amount: number;
  termMonths?: number;
  monthlyPayment?: number;
  status: "initiated" | "verified" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
}

// [Workers] Bindings connect your Worker to Cloudflare services. They are declared
// in wrangler.jsonc and injected at runtime via the `c.env` object in each handler.
// - REGISTRY: a Workers KV namespace for storing all demo data as JSON key-value pairs
// - ASSETS: serves the static frontend files from the /public directory
// - KYA_PROVIDER_URL: env var pointing at the external KYA verification service.
//   Phase 1: Mock Cloudflare Worker  → https://kya-provider-mock.workers.dev
//   Phase 2: AWS Lambda              → https://<id>.execute-api.<region>.amazonaws.com/kya
//   Phase 3: Hosted KYA provider API → https://<provider-host>/kya
type Bindings = {
  REGISTRY: KVNamespace;
  ASSETS: Fetcher;
  KYA_PROVIDER_URL: string;
};

// ─── Traced KV Helper ────────────────────────────────────────────────────────
// A thin wrapper around the Workers KV API that records timing for each operation.
// The standard KV API is: env.REGISTRY.get(key), env.REGISTRY.put(key, value).
// This wrapper adds instrumentation so the frontend can display a request trace.

class TracedKV {
  private kv: KVNamespace;
  private traces: TraceEntry[] = [];

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  // [Workers KV] Read a value from KV by key. KV stores values as strings;
  // passing "json" tells KV to automatically JSON.parse the result.
  async get<T>(key: string): Promise<T | null> {
    const start = Date.now();
    try {
      const value = await this.kv.get(key, "json");
      this.traces.push({
        service: "kv",
        op: `GET ${key}`,
        duration_ms: Date.now() - start,
        status: "ok",
      });
      return value as T | null;
    } catch (e) {
      this.traces.push({
        service: "kv",
        op: `GET ${key}`,
        duration_ms: Date.now() - start,
        status: "error",
      });
      throw e;
    }
  }

  // [Workers KV] Write a value to KV. Values are JSON-serialized before storage.
  // Optional `options` can include expirationTtl (seconds until auto-deletion).
  async put(key: string, value: unknown, options?: KVNamespacePutOptions): Promise<void> {
    const start = Date.now();
    try {
      await this.kv.put(key, JSON.stringify(value), options);
      this.traces.push({
        service: "kv",
        op: `PUT ${key}`,
        duration_ms: Date.now() - start,
        status: "ok",
      });
    } catch (e) {
      this.traces.push({
        service: "kv",
        op: `PUT ${key}`,
        duration_ms: Date.now() - start,
        status: "error",
      });
      throw e;
    }
  }

  addWorkerTrace(op: string, duration_ms: number, status: "ok" | "error" = "ok") {
    this.traces.push({ service: "worker", op, duration_ms, status });
  }

  getTraces(): TraceEntry[] {
    return [...this.traces];
  }
}

// ─── Token Generation ────────────────────────────────────────────────────────
// [Workers] The Workers runtime provides the Web Crypto API (crypto.randomUUID,
// crypto.subtle) — no Node.js crypto module needed. This runs natively in V8.

async function generateToken(): Promise<string> {
  // [Workers] crypto.randomUUID() generates a cryptographically random UUID
  const uuid = crypto.randomUUID();
  const encoder = new TextEncoder();
  const data = encoder.encode(uuid + Date.now().toString());
  // [Workers] crypto.subtle.digest() performs SHA-256 hashing on the edge
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Input Validation Helper ─────────────────────────────────────────────────

interface FieldRule {
  name: string;
  type: "string" | "number" | "boolean" | "array";
  required?: boolean;
}

/** Validate request body fields. Returns an error message or null if valid. */
function validateBody(body: Record<string, unknown>, rules: FieldRule[]): string | null {
  for (const rule of rules) {
    const val = body[rule.name];
    if (rule.required && (val === undefined || val === null || val === "")) {
      return `Missing required field: ${rule.name}`;
    }
    if (val !== undefined && val !== null) {
      if (rule.type === "array") {
        if (!Array.isArray(val)) return `Field "${rule.name}" must be an array`;
      } else if (typeof val !== rule.type) {
        return `Field "${rule.name}" must be a ${rule.type}, got ${typeof val}`;
      }
      if (rule.type === "number" && (typeof val === "number") && (isNaN(val) || !isFinite(val))) {
        return `Field "${rule.name}" must be a finite number`;
      }
    }
  }
  return null;
}

// ─── Request Metadata Helper ─────────────────────────────────────────────────

// [Workers] Every incoming request to a Worker has a `cf` object with metadata
// about the Cloudflare data center (POP) that handled it. `cf.colo` is the
// 3-letter IATA airport code (e.g., "SFO", "LHR") of the nearest edge location.
function getColo(c: { req: { raw: Request } }): string {
  return ((c.req.raw as any).cf?.colo as string) ?? "local";
}

// ─── App Setup ───────────────────────────────────────────────────────────────

// [Hono] Create the Hono app, typed with our Bindings so c.env.REGISTRY and
// c.env.ASSETS are fully typed throughout all route handlers.
const app = new Hono<{ Bindings: Bindings }>();

// [Hono] Apply CORS middleware to all /api/* routes so the frontend can call them.
app.use("/api/*", cors());

// ─── Reset (clear demo state) ────────────────────────────────────────────────

app.post("/api/reset", async (c) => {
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  // [Workers KV] List all keys by prefix and delete them. KV.list() returns
  // keys matching a prefix — useful for scanning a "table" of related records.
  const prefixes = ["shopper:", "merchant:", "agent:", "delegation:", "token:", "transaction:"];
  for (const prefix of prefixes) {
    const list = await c.env.REGISTRY.list({ prefix });
    for (const key of list.keys) {
      await c.env.REGISTRY.delete(key.name);
    }
  }

  tkv.addWorkerTrace("reset_all_data", Date.now() - start);

  // [Hono] c.json() serializes an object as a JSON response with correct headers.
  return c.json({
    success: true,
    message: "All demo data cleared",
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Register Shopper ────────────────────────────────────────────────────────

// [Hono] app.post() defines a POST route handler. The callback receives a
// Context object `c` with access to the request (c.req) and bindings (c.env).
app.post("/api/register/shopper", async (c) => {
  // [Workers] Access the KV binding via c.env.REGISTRY — this is the KV namespace
  // configured in wrangler.jsonc. TracedKV wraps it with timing instrumentation.
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  // [Hono] Parse the incoming JSON request body.
  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  // [Agentic Commerce Registry] Validate required fields for shopper registration.
  const err = validateBody(body, [
    { name: "name", type: "string", required: true },
    { name: "email", type: "string", required: true },
    { name: "creditScore", type: "number" },
    { name: "creditLimit", type: "number" },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Agentic Commerce Registry] Build the shopper identity record.
  const genStart = Date.now();
  // [Workers] crypto.randomUUID() generates a unique ID — part of the Web Crypto API.
  const id = body.id || `shopper-${crypto.randomUUID().slice(0, 8)}`;
  const shopper: Shopper = {
    id,
    name: body.name,
    email: body.email,
    creditScore: body.creditScore ?? 750,
    creditLimit: body.creditLimit ?? 10000,
    registeredAt: new Date().toISOString(),
  };
  tkv.addWorkerTrace("build_identity", Date.now() - genStart);

  // [Workers KV] Persist the shopper to KV. The key "shopper:{id}" is a namespaced
  // pattern — KV is a flat key-value store, so prefixes act as logical "tables".
  await tkv.put(`shopper:${id}`, shopper);

  // [Hono] Return the created shopper as a JSON response.
  return c.json({
    success: true,
    data: shopper,
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Register Merchant ───────────────────────────────────────────────────────

app.post("/api/register/merchant", async (c) => {
  // [Workers] Access the KV binding configured in wrangler.jsonc.
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  // [Hono] Parse the incoming JSON request body.
  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  // [Agentic Commerce Registry] Validate fields for merchant registration.
  const err = validateBody(body, [
    { name: "name", type: "string", required: true },
    { name: "businessType", type: "string" },
    { name: "acceptsLoans", type: "boolean" },
    { name: "acceptsLeases", type: "boolean" },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Agentic Commerce Registry] Build the merchant identity with business capabilities.
  const genStart = Date.now();
  const id = body.id || `merchant-${crypto.randomUUID().slice(0, 8)}`;
  const merchant: Merchant = {
    id,
    name: body.name,
    businessType: body.businessType ?? "retail",
    acceptsLoans: body.acceptsLoans ?? true,
    acceptsLeases: body.acceptsLeases ?? true,
    registeredAt: new Date().toISOString(),
  };
  tkv.addWorkerTrace("build_identity", Date.now() - genStart);

  // [Workers KV] Persist the merchant to KV under the "merchant:" prefix.
  await tkv.put(`merchant:${id}`, merchant);

  return c.json({
    success: true,
    data: merchant,
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Register Agent ──────────────────────────────────────────────────────────
// [Agentic Commerce Registry] Agent registration now includes a KYA (Know Your Agent)
// verification step. After building the agent identity, the Worker makes an outbound
// fetch() call to an external KYA provider to obtain a signed identity token.
// The token is stored in the agent's KV record alongside the agent data.
// If the KYA provider is unreachable, the agent still registers with status "PENDING"
// (graceful degradation — the KYA call never blocks registration).

app.post("/api/register/agent", async (c) => {
  // [Workers] Access the KV binding configured in wrangler.jsonc.
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  // [Hono] Parse the incoming JSON request body.
  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  // [Agentic Commerce Registry] Validate fields for AI agent registration.
  const err = validateBody(body, [
    { name: "name", type: "string", required: true },
    { name: "capabilities", type: "array" },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Agentic Commerce Registry] Build the agent identity with its capabilities.
  const genStart = Date.now();
  const id = body.id || `agent-${crypto.randomUUID().slice(0, 8)}`;
  const capabilities: string[] = body.capabilities ?? ["purchase", "negotiate"];
  const agent: Agent = {
    id,
    name: body.name,
    capabilities,
    registeredAt: new Date().toISOString(),
  };
  tkv.addWorkerTrace("build_identity", Date.now() - genStart);

  // ── KYA Verification ────────────────────────────────────────────────────────
  // [Workers] Make an outbound fetch() to the external KYA provider.
  // This is a plain HTTP call — no service binding — simulating a real external API.
  // KYA_PROVIDER_URL is an env var set in wrangler.jsonc:
  //   Phase 1: Mock Cloudflare Worker  → https://kya-provider-mock.workers.dev
  //   Phase 2: AWS Lambda              → https://<id>.execute-api.<region>.amazonaws.com/kya
  //   Phase 3: Hosted KYA provider API → https://<provider-host>/kya
  const kyaStart = Date.now();
  try {
    const kyaRes = await fetch(`${c.env.KYA_PROVIDER_URL}/kya/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, agentName: body.name, capabilities }),
    });

    if (kyaRes.ok) {
      // [Agentic Commerce Registry] KYA verification succeeded — attach token to agent record.
      const kyaData = await kyaRes.json() as {
        token: string;
        tokenId: string;
        claims: { bid: { verification_status: string }; apd: { provider: string } };
      };
      agent.kyaToken = kyaData.token;
      agent.kyaTokenId = kyaData.tokenId;
      agent.kyaVerificationStatus = kyaData.claims.bid.verification_status as KyaVerificationStatus;
      agent.kyaProvider = kyaData.claims.apd.provider;
      agent.kyaVerifiedAt = new Date().toISOString();
      tkv.addWorkerTrace("kya_verify", Date.now() - kyaStart, "ok");
    } else {
      // [Agentic Commerce Registry] KYA provider returned an error — degrade gracefully.
      agent.kyaVerificationStatus = "PENDING";
      agent.kyaProvider = "unavailable";
      tkv.addWorkerTrace("kya_verify", Date.now() - kyaStart, "error");
    }
  } catch {
    // [Workers] fetch() threw (network error, DNS failure, timeout) — degrade gracefully.
    // The agent is still registered; KYA can be retried later via GET /api/agent/:id/kya.
    agent.kyaVerificationStatus = "PENDING";
    agent.kyaProvider = "unavailable";
    tkv.addWorkerTrace("kya_verify", Date.now() - kyaStart, "error");
  }

  // [Workers KV] Persist the agent (with KYA fields) to KV under the "agent:" prefix.
  await tkv.put(`agent:${id}`, agent);

  return c.json({
    success: true,
    data: agent,
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Get Agent KYA Status ────────────────────────────────────────────────────
// [Agentic Commerce Registry] Retrieve the KYA token and verification status for
// a registered agent. Useful for the seller-side verification flow and for
// re-checking KYA status if the initial registration had status "PENDING".

app.get("/api/agent/:id/kya", async (c) => {
  // [Workers] Access the KV binding to look up the agent record.
  const tkv = new TracedKV(c.env.REGISTRY);
  const agentId = c.req.param("id");

  const agent = await tkv.get<Agent>(`agent:${agentId}`);
  if (!agent) {
    return c.json({ success: false, error: `Agent ${agentId} not found`, _colo: getColo(c), _trace: tkv.getTraces() }, 404);
  }

  return c.json({
    success: true,
    data: {
      agentId: agent.id,
      agentName: agent.name,
      kyaToken: agent.kyaToken,
      kyaTokenId: agent.kyaTokenId,
      kyaVerificationStatus: agent.kyaVerificationStatus ?? "PENDING",
      kyaProvider: agent.kyaProvider ?? "unavailable",
      kyaVerifiedAt: agent.kyaVerifiedAt,
    },
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Delegate Authority ──────────────────────────────────────────────────────
// [Agentic Commerce Registry] This is the core trust mechanism: a shopper grants
// an AI agent limited, scoped authority to act on their behalf.

app.post("/api/delegate", async (c) => {
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  // [Agentic Commerce Registry] Validate delegation parameters: who delegates, to whom, and with what limits.
  const err = validateBody(body, [
    { name: "shopperId", type: "string", required: true },
    { name: "agentId", type: "string", required: true },
    { name: "maxAmount", type: "number" },
    { name: "scope", type: "array" },
    { name: "allowedTransactionTypes", type: "array" },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Workers KV] Look up the shopper from KV to verify they exist before delegating.
  const shopper = await tkv.get<Shopper>(`shopper:${body.shopperId}`);
  if (!shopper) {
    return c.json({ success: false, error: "Shopper not found", _colo: getColo(c), _trace: tkv.getTraces() }, 404);
  }

  // [Workers KV] Look up the agent from KV to verify they are registered.
  const agent = await tkv.get<Agent>(`agent:${body.agentId}`);
  if (!agent) {
    return c.json({ success: false, error: "Agent not found", _colo: getColo(c), _trace: tkv.getTraces() }, 404);
  }

  // [Workers] Generate a cryptographic delegation token using the Web Crypto API (SHA-256).
  const tokenStart = Date.now();
  const token = await generateToken();
  tkv.addWorkerTrace("generate_delegation_token", Date.now() - tokenStart);

  // [Agentic Commerce Registry] Build the delegation record: scope, spending limit,
  // allowed transaction types, and a 24-hour expiry window.
  const delegation: Delegation = {
    agentId: body.agentId,
    shopperId: body.shopperId,
    scope: body.scope ?? ["purchase"],
    maxAmount: body.maxAmount ?? 5000,
    allowedTransactionTypes: body.allowedTransactionTypes ?? ["loan", "lease"],
    token,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    createdAt: new Date().toISOString(),
  };

  // [Workers KV] Store the delegation record with expirationTtl — KV will automatically
  // delete this key after 86400 seconds (24 hours). No cron job or cleanup needed.
  await tkv.put(`delegation:${body.agentId}:${body.shopperId}`, delegation, { expirationTtl: 86400 });

  // [Workers KV] Store a separate token-lookup entry for fast O(1) verification.
  // Also uses KV's native TTL so expired tokens are automatically cleaned up.
  await tkv.put(`token:${token}`, {
    agentId: body.agentId,
    shopperId: body.shopperId,
    scope: delegation.scope,
    maxAmount: delegation.maxAmount,
    allowedTransactionTypes: delegation.allowedTransactionTypes,
    expiresAt: delegation.expiresAt,
  }, { expirationTtl: 86400 });

  return c.json({
    success: true,
    data: {
      delegation: {
        agentId: delegation.agentId,
        agentName: agent.name,
        shopperId: delegation.shopperId,
        shopperName: shopper.name,
        scope: delegation.scope,
        maxAmount: delegation.maxAmount,
        allowedTransactionTypes: delegation.allowedTransactionTypes,
        token: delegation.token,
        expiresAt: delegation.expiresAt,
      },
    },
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Verify Token ────────────────────────────────────────────────────────────
// [Agentic Commerce Registry] A merchant calls this to verify that an agent's
// delegation token is valid and to learn the shopper's identity and credit profile.

app.post("/api/verify", async (c) => {
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  const err = validateBody(body, [
    { name: "token", type: "string", required: true },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Workers KV] Look up the delegation token from KV. If the token has expired,
  // KV's native TTL will have already deleted it, so this returns null.
  const tokenData = await tkv.get<{
    agentId: string;
    shopperId: string;
    scope: string[];
    maxAmount: number;
    allowedTransactionTypes: string[];
    expiresAt: string;
  }>(`token:${body.token}`);

  if (!tokenData) {
    tkv.addWorkerTrace("token_validation", 0, "error");
    return c.json({
      success: false,
      error: "Token not found or invalid",
      verified: false,
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 401);
  }

  // [Agentic Commerce Registry] Double-check expiry in application code as a safety net
  // (KV TTL is eventually consistent, so there's a small window where expired keys may linger).
  const validStart = Date.now();
  const isExpired = new Date(tokenData.expiresAt) < new Date();
  tkv.addWorkerTrace("check_token_expiry", Date.now() - validStart);

  if (isExpired) {
    return c.json({
      success: false,
      error: "Token has expired",
      verified: false,
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 401);
  }

  // [Workers KV] Parallel KV reads — fetch delegation details and shopper credit
  // info concurrently. Promise.all makes both KV lookups happen at the same time.
  const [delegation, shopper] = await Promise.all([
    tkv.get<Delegation>(`delegation:${tokenData.agentId}:${tokenData.shopperId}`),
    tkv.get<Shopper>(`shopper:${tokenData.shopperId}`),
  ]);

  const compileStart = Date.now();
  tkv.addWorkerTrace("compile_verification_result", Date.now() - compileStart);

  // [Agentic Commerce Registry] Return the verified identity, credit profile,
  // and delegation scope so the merchant knows what the agent is authorized to do.
  return c.json({
    success: true,
    verified: true,
    data: {
      agentId: tokenData.agentId,
      shopperId: tokenData.shopperId,
      shopperName: shopper?.name,
      shopperCreditScore: shopper?.creditScore,
      shopperCreditLimit: shopper?.creditLimit,
      scope: tokenData.scope,
      maxAmount: tokenData.maxAmount,
      allowedTransactionTypes: tokenData.allowedTransactionTypes,
      expiresAt: tokenData.expiresAt,
    },
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ─── Initiate Transaction ────────────────────────────────────────────────────
// [Agentic Commerce Registry] The agent initiates a purchase on behalf of the
// shopper. This handler enforces every delegation constraint before creating the transaction.

app.post("/api/transaction/initiate", async (c) => {
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  const err = validateBody(body, [
    { name: "token", type: "string", required: true },
    { name: "merchantId", type: "string", required: true },
    { name: "amount", type: "number", required: true },
    { name: "type", type: "string" },
    { name: "itemDescription", type: "string" },
    { name: "termMonths", type: "number" },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Workers KV] Verify the delegation token by looking it up in KV.
  const tokenData = await tkv.get<{
    agentId: string;
    shopperId: string;
    scope: string[];
    maxAmount: number;
    allowedTransactionTypes: string[];
    expiresAt: string;
  }>(`token:${body.token}`);

  if (!tokenData) {
    tkv.addWorkerTrace("token_validation", 0, "error");
    return c.json({ success: false, error: "Invalid token", _colo: getColo(c), _trace: tkv.getTraces() }, 401);
  }

  // [Agentic Commerce Registry] Check token expiry.
  const validStart = Date.now();
  if (new Date(tokenData.expiresAt) < new Date()) {
    tkv.addWorkerTrace("check_token_expiry", Date.now() - validStart, "error");
    return c.json({ success: false, error: "Token expired", _colo: getColo(c), _trace: tkv.getTraces() }, 401);
  }
  tkv.addWorkerTrace("check_token_expiry", Date.now() - validStart);

  // [Agentic Commerce Registry] Enforce delegation constraint: transaction type must be allowed.
  const typeCheckStart = Date.now();
  const txType = body.type ?? "lease";
  if (!tokenData.allowedTransactionTypes.includes(txType)) {
    tkv.addWorkerTrace("check_transaction_type", Date.now() - typeCheckStart, "error");
    return c.json({
      success: false,
      error: `Transaction type "${txType}" not permitted by delegation`,
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 403);
  }
  tkv.addWorkerTrace("check_transaction_type", Date.now() - typeCheckStart);

  // [Agentic Commerce Registry] Enforce delegation constraint: amount must be within the spending limit.
  const amountCheckStart = Date.now();
  if (body.amount > tokenData.maxAmount) {
    tkv.addWorkerTrace("check_amount_limit", Date.now() - amountCheckStart, "error");
    return c.json({
      success: false,
      error: `Amount $${body.amount} exceeds delegation limit of $${tokenData.maxAmount}`,
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 403);
  }
  tkv.addWorkerTrace("check_amount_limit", Date.now() - amountCheckStart);

  // [Workers KV] Look up the merchant from KV to verify existence and capabilities.
  const merchant = await tkv.get<Merchant>(`merchant:${body.merchantId}`);
  if (!merchant) {
    return c.json({ success: false, error: "Merchant not found", _colo: getColo(c), _trace: tkv.getTraces() }, 404);
  }

  // [Agentic Commerce Registry] Verify the merchant supports this transaction type.
  const merchantCheckStart = Date.now();
  if (txType === "loan" && !merchant.acceptsLoans) {
    tkv.addWorkerTrace("check_merchant_capabilities", Date.now() - merchantCheckStart, "error");
    return c.json({
      success: false,
      error: "Merchant does not accept loans",
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 400);
  }
  if (txType === "lease" && !merchant.acceptsLeases) {
    tkv.addWorkerTrace("check_merchant_capabilities", Date.now() - merchantCheckStart, "error");
    return c.json({
      success: false,
      error: "Merchant does not accept leases",
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 400);
  }
  tkv.addWorkerTrace("check_merchant_capabilities", Date.now() - merchantCheckStart);

  // [Workers KV] Look up the shopper from KV for the credit check.
  const shopper = await tkv.get<Shopper>(`shopper:${tokenData.shopperId}`);

  // [Agentic Commerce Registry] Run a credit check — ensure amount is within the shopper's credit limit.
  const creditCheckStart = Date.now();
  if (shopper && body.amount > shopper.creditLimit) {
    tkv.addWorkerTrace("credit_check", Date.now() - creditCheckStart, "error");
    return c.json({
      success: false,
      error: `Amount exceeds shopper credit limit of $${shopper.creditLimit}`,
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 403);
  }
  tkv.addWorkerTrace("credit_check", Date.now() - creditCheckStart);

  // [Agentic Commerce Registry] All checks passed — create the transaction record.
  const txId = `tx-${crypto.randomUUID().slice(0, 8)}`;
  const termMonths = body.termMonths ?? 12;
  const transaction: Transaction = {
    id: txId,
    agentId: tokenData.agentId,
    shopperId: tokenData.shopperId,
    merchantId: body.merchantId,
    type: txType,
    itemDescription: body.itemDescription ?? "Item",
    amount: body.amount,
    termMonths,
    monthlyPayment: Math.round((body.amount / termMonths) * 100) / 100,
    status: "initiated",
    createdAt: new Date().toISOString(),
  };

  // [Workers KV] Persist the transaction to KV.
  await tkv.put(`transaction:${txId}`, transaction);

  return c.json({
    success: true,
    data: {
      transaction,
      shopperName: shopper?.name,
      merchantName: merchant.name,
    },
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// ──── Complete Transaction ────────────────────────────────────────────────────
// [Agentic Commerce Registry] Finalize the transaction — mark it as completed
// and return a full summary of all parties involved.

app.post("/api/transaction/complete", async (c) => {
  const tkv = new TracedKV(c.env.REGISTRY);
  const start = Date.now();

  const body = await c.req.json();
  tkv.addWorkerTrace("parse_request", Date.now() - start);

  const err = validateBody(body, [
    { name: "transactionId", type: "string", required: true },
  ]);
  if (err) return c.json({ success: false, error: err, _colo: getColo(c), _trace: tkv.getTraces() }, 400);

  // [Workers KV] Look up the existing transaction from KV.
  const transaction = await tkv.get<Transaction>(`transaction:${body.transactionId}`);
  if (!transaction) {
    return c.json({
      success: false,
      error: "Transaction not found",
      _colo: getColo(c),
      _trace: tkv.getTraces(),
    }, 404);
  }

  // [Agentic Commerce Registry] Mark the transaction as completed with a timestamp.
  const updateStart = Date.now();
  transaction.status = "completed";
  transaction.completedAt = new Date().toISOString();
  tkv.addWorkerTrace("finalize_agreement", Date.now() - updateStart);

  // [Workers KV] Update the transaction record in KV with the new status.
  await tkv.put(`transaction:${transaction.id}`, transaction);

  // [Workers KV] Parallel KV reads — fetch all related entities (shopper, merchant,
  // agent) concurrently to build the transaction summary.
  const [shopper, merchant, agent] = await Promise.all([
    tkv.get<Shopper>(`shopper:${transaction.shopperId}`),
    tkv.get<Merchant>(`merchant:${transaction.merchantId}`),
    tkv.get<Agent>(`agent:${transaction.agentId}`),
  ]);

  return c.json({
    success: true,
    data: {
      transaction,
      summary: {
        shopper: shopper?.name,
        merchant: merchant?.name,
        agent: agent?.name,
        item: transaction.itemDescription,
        type: transaction.type,
        amount: `$${transaction.amount}`,
        term: `${transaction.termMonths} months`,
        monthlyPayment: `$${transaction.monthlyPayment}`,
        status: transaction.status,
      },
    },
    _colo: getColo(c),
    _trace: tkv.getTraces(),
  });
});

// [Workers] Export the Hono app as the default export — this is how Cloudflare
// Workers know which object handles incoming requests (the "module worker" format).
export default app;
