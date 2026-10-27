// Ambient type declarations for the cloudflare:test module.
// Tells TypeScript what bindings are available in test files via `env` from cloudflare:test.
// This mirrors the Bindings type in src/index.ts + wrangler.jsonc.

declare module "cloudflare:test" {
  interface ProvidedEnv {
    REGISTRY: KVNamespace;
    ASSETS: Fetcher;
    KYA_PROVIDER_URL: string;
  }
}
