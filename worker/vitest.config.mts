import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.test.toml" },
            miniflare: {
                kvNamespaces: ["WARMUP_STATE"],
            },
        }),
    ],
    test: {
        setupFiles: ["./test/setup.ts"],
        coverage: {
            provider: "istanbul", // v8 coverage is unsupported under the workers pool
            include: ["src/**/*.ts"],
            reporter: ["text", "html", "lcov"],
            thresholds: {
                statements: 100,
                branches: 100,
                functions: 100,
                lines: 100,
            },
        },
    },
});
