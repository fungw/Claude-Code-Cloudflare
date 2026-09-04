import { afterEach, beforeEach, vi } from "vitest";

/**
 * Guarantees the suite can never spend a real rate-limit window: any code path
 * that reaches the real `fetch` without a test explicitly injecting or
 * stubbing one throws instead of dialing out.
 *
 * (The installed @cloudflare/vitest-pool-workers version does not export the
 * `fetchMock` undici-mocking helper documented for earlier versions, so this
 * is a plain global-fetch guard instead. Tests inject a fake `fetchImpl` via
 * the seams in src/anthropic.ts, or call `vi.stubGlobal("fetch", ...)` for the
 * handful of integration tests that go through the real handlers.)
 */
beforeEach(() => {
    vi.stubGlobal("fetch", async () => {
        throw new Error(
            "Unexpected real fetch() call in a test — inject fetchImpl/sleep or vi.stubGlobal('fetch', ...)."
        );
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});
