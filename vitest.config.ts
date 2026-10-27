// [Workers] Vitest configuration using @cloudflare/vitest-pool-workers.
// This runs tests inside the actual Workers runtime (V8 isolate via Miniflare),
// giving us real KV bindings, real fetch(), and real Workers APIs in tests.
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: ['test/production.test.ts', '**/node_modules/**', '**/chat-agent/**', '**/remote-mcp-server-authless/**'],
    poolOptions: {
      workers: {
        main: './src/index.ts',
        miniflare: { bindings: { KYA_PROVIDER_URL: 'https://kya-provider-mock.workers.dev' } },
        // [Workers] Point at the registry Worker's wrangler config so the test
        // runner picks up the REGISTRY KV binding and KYA_PROVIDER_URL var.
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
