import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: {
 '@mortise/server/node': fileURLToPath(new URL('./packages/server/src/node.ts', import.meta.url)),
 '@mortise/server': fileURLToPath(new URL('./packages/server/src/index.ts', import.meta.url)),
 '@mortise/rsc/server': fileURLToPath(new URL('./packages/rsc/src/server.ts', import.meta.url)),
 '@mortise/rsc/client': fileURLToPath(new URL('./packages/rsc/src/client.tsx', import.meta.url)),
 '@mortise/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
 '@mortise/react': fileURLToPath(new URL('./packages/react/src/index.tsx', import.meta.url)),
}}, test: { include: ['packages/**/*.test.{ts,tsx}'], environment: 'jsdom', pool: 'forks', maxWorkers: 1 } });
