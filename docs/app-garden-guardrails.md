# Production guardrails and deployment readiness

Wrangler now bundles `src/production.ts`. The full KYA demo source (`src/index.ts`) is retained but not imported by this entrypoint. The existing local experiment tests run with `vitest.config.ts`; production ownership tests use `vitest.production.config.ts`. Neither test suite calls live services.

## Ownership

An explicit same-origin POST to `/api/session` issues an HttpOnly, Secure, SameSite=Strict `__Host-commerce_session` cookie (HTTP localhost uses `commerce_session`). SHA-256 of its 256-bit token identifies the owner. Every KV key has `session:<owner-hash>:<reset-generation>:` before its logical key. Registration, delegation, verification, initiation and completion all require this session and resolve only its records. Caller IDs cannot select another owner's namespace.

`POST /api/reset` rotates the caller's generation before deleting its records. Previous-generation writes become inaccessible; retained-record reservations remain until their original TTL because a KV write already in flight may finish after reset. Repeated resets cannot recycle the global retention budget. KV is eventually consistent: demo writes may need retry before reads, and reset is namespace invalidation rather than a claim of immediate worldwide physical deletion.

Global/legacy cleanup uses `/api/operator/reset`, optional secret name `REGISTRY_OPERATOR_TOKEN`, a Bearer header and an allowlisted prefix. It processes at most 100 records per call, returns the next cursor and permits at most 10 maintenance calls/hour. With no secret the route is disabled. Never place a secret value in configuration, source, URLs or logs. Legacy unscoped records are inaccessible to public sessions but still occupy KV: perform an explicitly authorized operator cleanup before claiming that the entire namespace meets the new retention cap.

## Configurable conservative defaults

The fixed `AUTHORITY` singleton serializes global budgets across locations. Missing settings use defaults; malformed/out-of-range settings throw and fail closed.

| Variable | Default | Maximum allowed |
| --- | ---: | ---: |
| SESSION_TTL_SECONDS | 7200 | 86400 |
| MAX_SESSIONS | 100 | 1000 |
| NEW_SESSIONS_PER_HOUR | 20 | 1000 |
| MAX_RECORDS | 5000 | 10000 |
| MAX_SESSION_RECORDS | 100 | 500 |
| SESSION_ACTIONS_PER_MINUTE | 30 | 120 |
| GLOBAL_ACTIONS_PER_MINUTE | 120 | 1000 |
| GLOBAL_ACTIONS_PER_DAY | 1000 | 10000 |

There is also a 3-new-session/hour per-IP ceiling and a streaming 16 KiB JSON body cap. KV writes use absolute `expiration = floor(scope.expiresAt / 1000)`, never relative expirationTtl. After reservation, the deadline must still be at least 60 whole seconds in the future. A delayed put cannot restart the TTL past its authoritative reservation; past-deadline puts are rejected by KV. Failed/in-flight writes retain conservative reservations through the original session expiry, including reset epochs. Runtime tests inject delayed KV completion, storage failure and a delayed reservation at the minimum-future-expiry boundary. These bound admitted application work/storage, not raw incoming HTTP requests or a dollar spend ceiling. Over-budget and missing-binding failures do not fall back to unbounded operation.

## Checks and future deployment

```sh
npm run cf-typegen
npm run typecheck:production
npm run test:production
npm test
npx --no-install wrangler deploy --minify --dry-run
npm run deploy
```

The additive `v1` migration creates SQLite `CommerceAuthority`; binding `AUTHORITY` is required. Existing `REGISTRY` and `ASSETS` remain. The production Worker does not require a KYA URL, AI binding, service binding or MCP provider. Do not use companion deploy commands as part of this deployment.

The canonical public landing, real robots and XML sitemap remain discoverable; API/action URLs are excluded and noindexed. Content Signals request search and AI-input use while declining AI training. These signals are crawler guidance, not authorization.
