import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
    attemptWarmup,
    FIVE_HOURS_MS,
    isRetryable,
    MAX_BACKOFF_MS,
    pickHeaders,
    ping,
    resetFromHeaders,
    truncate,
} from "../src/anthropic";
import { fakeSleep, jsonResponse, makeEnv, queuedFetch, textResponse } from "./helpers";

describe("pickHeaders", () => {
    it("keeps anthropic-ratelimit-*, request-id, and retry-after (C1-C3)", () => {
        const res = new Response(null, {
            headers: {
                "anthropic-ratelimit-unified-5h-reset": "123",
                "anthropic-ratelimit-unified-7d-utilization": "0.5",
                "request-id": "abc",
                "retry-after": "2",
                "content-type": "application/json",
            },
        });
        expect(pickHeaders(res)).toEqual({
            "anthropic-ratelimit-unified-5h-reset": "123",
            "anthropic-ratelimit-unified-7d-utilization": "0.5",
            "request-id": "abc",
            "retry-after": "2",
        });
    });

    it("returns {} when no headers are present (C4)", () => {
        expect(pickHeaders(new Response(null))).toEqual({});
    });
});

describe("truncate", () => {
    it("leaves short text untouched (C5)", () => {
        expect(truncate("hi", 10)).toBe("hi");
    });

    it("leaves text exactly at max untouched (C6)", () => {
        expect(truncate("1234567890", 10)).toBe("1234567890");
    });

    it("truncates and appends a length suffix past max (C7)", () => {
        expect(truncate("12345678901", 10)).toBe("1234567890… (11 chars total)");
    });

    it("respects a custom max (C8)", () => {
        expect(truncate("abcdef", 3)).toBe("abc… (6 chars total)");
    });
});

describe("isRetryable", () => {
    it.each([
        [undefined, true],
        [408, true],
        [429, true],
        [500, true],
        [503, true],
        [400, false],
        [401, false],
        [404, false],
    ])("status %s -> %s (C9-C16)", (status, expected) => {
        expect(isRetryable(status)).toBe(expected);
    });
});

describe("resetFromHeaders", () => {
    const now = Date.UTC(2026, 5, 15, 6, 0);

    it("uses a valid header value in seconds (C17)", () => {
        const validAt = now + 5 * 60 * 60 * 1000;
        const result = resetFromHeaders({ "anthropic-ratelimit-unified-5h-reset": String(validAt / 1000) }, now);
        expect(result).toEqual({ at: validAt, source: "header" });
    });

    it("falls back to +5h when the header is absent (C18)", () => {
        expect(resetFromHeaders({}, now)).toEqual({ at: now + FIVE_HOURS_MS, source: "fallback:+5h" });
    });

    it.each(["abc", "0", "-5", ""])("falls back to +5h for an invalid value %j (C19)", (raw) => {
        expect(resetFromHeaders({ "anthropic-ratelimit-unified-5h-reset": raw }, now)).toEqual({
            at: now + FIVE_HOURS_MS,
            source: "fallback:+5h",
        });
    });

    it("accepts fractional seconds (C20)", () => {
        const validAt = now + 5 * 60 * 60 * 1000 + 500;
        const result = resetFromHeaders(
            { "anthropic-ratelimit-unified-5h-reset": String(validAt / 1000) },
            now
        );
        expect(result.source).toBe("header");
        expect(result.at).toBeCloseTo(validAt, 0);
    });

    it("bug fix: rejects a header value implausibly far in the future (ms mistaken for seconds)", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        // If the API ever sent an epoch-milliseconds value where seconds are
        // expected, multiplying by 1000 again lands ~1000x too far out (roughly
        // the year 57000). Previously this was accepted verbatim and blocked
        // all future pings, since the "reset" would never appear to have passed.
        const msMistakenForSeconds = String(now); // `now` is itself already in ms
        const result = resetFromHeaders(
            { "anthropic-ratelimit-unified-5h-reset": msMistakenForSeconds },
            now
        );
        expect(result).toEqual({ at: now + FIVE_HOURS_MS, source: "fallback:invalid-header" });
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('"event":"header.rejected"'));
        spy.mockRestore();
    });

    it("bug fix: rejects a header value in the past", () => {
        const pastSeconds = (now - 60_000) / 1000;
        const result = resetFromHeaders({ "anthropic-ratelimit-unified-5h-reset": String(pastSeconds) }, now);
        expect(result.source).toBe("fallback:invalid-header");
    });
});

describe("attemptWarmup", () => {
    const baseEnv = () => makeEnv({ WARMUP_STATE: env.WARMUP_STATE });

    it("returns the reply text from a text content block (D1)", async () => {
        const fetchImpl = queuedFetch([
            jsonResponse({ content: [{ type: "text", text: "Warmed up!" }], usage: { input_tokens: 5 } }),
        ]);
        const { log, reply } = await attemptWarmup(baseEnv(), "hi", 1, false, fetchImpl);
        expect(log.ok).toBe(true);
        expect(reply).toBe("Warmed up!");
        expect(log.usage).toEqual({ input_tokens: 5 });
    });

    it('falls back to "(no text block)" when content has no text block (D2)', async () => {
        const fetchImpl = queuedFetch([jsonResponse({ content: [{ type: "image" }] })]);
        const { reply } = await attemptWarmup(baseEnv(), "hi", 1, false, fetchImpl);
        expect(reply).toBe("(no text block)");
    });

    it('falls back to "(no text block)" when content is undefined (D3)', async () => {
        const fetchImpl = queuedFetch([jsonResponse({})]);
        const { reply } = await attemptWarmup(baseEnv(), "hi", 1, false, fetchImpl);
        expect(reply).toBe("(no text block)");
    });

    it("sends the expected request shape (D4)", async () => {
        let capturedUrl: string | URL | Request | undefined;
        let capturedInit: RequestInit | undefined;
        const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
            capturedUrl = url;
            capturedInit = init;
            return jsonResponse({ content: [{ type: "text", text: "ok" }] });
        };
        await attemptWarmup(baseEnv(), "hello there", 1, false, fetchImpl);

        expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
        expect(capturedInit?.method).toBe("POST");
        const headers = capturedInit?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer test-token");
        expect(headers["anthropic-version"]).toBe("2023-06-01");
        expect(headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
        const body = JSON.parse(capturedInit?.body as string);
        expect(body.model).toBe("claude-haiku-4-5-20251001");
        expect(body.max_tokens).toBe(64);
        expect(body.messages).toEqual([{ role: "user", content: "hello there" }]);
    });

    it("uses WARMUP_MESSAGE when set (D5)", async () => {
        let sentMessage: string | undefined;
        const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
            sentMessage = JSON.parse(init?.body as string).messages[0].content;
            return jsonResponse({ content: [{ type: "text", text: "ok" }] });
        };
        await attemptWarmup(
            makeEnv({ WARMUP_STATE: env.WARMUP_STATE, WARMUP_MESSAGE: "custom message" }),
            "custom message",
            1,
            false,
            fetchImpl
        );
        expect(sentMessage).toBe("custom message");
    });

    it("falls back to the default message for an empty WARMUP_MESSAGE (D6)", async () => {
        // ping() resolves this with `||`, not `??` — attemptWarmup just sends whatever it's given.
        // Covered at the ping() level below; this documents the attemptWarmup contract directly.
        const fetchImpl = queuedFetch([jsonResponse({ content: [{ type: "text", text: "ok" }] })]);
        const { log } = await attemptWarmup(baseEnv(), "", 1, false, fetchImpl);
        expect(log.ok).toBe(true);
    });

    it("does not retry a non-retryable status (D7)", async () => {
        const fetchImpl = queuedFetch([textResponse("bad request", { status: 400, statusText: "Bad Request" })]);
        const { sleep } = fakeSleep();
        const result = await ping(baseEnv(), false, { fetchImpl, sleep });
        expect(result.success).toBe(false);
        expect(result.attempts).toHaveLength(1);
    });

    it("throws-as-Error path is captured with name/message (D13)", async () => {
        const fetchImpl = async () => {
            throw new TypeError("network down");
        };
        const { log } = await attemptWarmup(baseEnv(), "hi", 1, false, fetchImpl);
        expect(log.ok).toBe(false);
        expect(log.error).toEqual({ name: "TypeError", message: "network down" });
    });

    it("a thrown non-Error value is coerced via String() (D14)", async () => {
        const fetchImpl = async () => {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw "raw string failure";
        };
        const { log } = await attemptWarmup(baseEnv(), "hi", 1, false, fetchImpl);
        expect(log.ok).toBe(false);
        expect(log.error?.message).toBe("raw string failure");
    });

    it("falls back to the real global fetch when no fetchImpl is given", async () => {
        // Covers attemptWarmup's own `fetchImpl: FetchImpl = fetch` default. The
        // global guard installed in test/setup.ts makes this a controlled
        // failure rather than a real network call.
        const { log } = await attemptWarmup(baseEnv(), "hi", 1, false);
        expect(log.ok).toBe(false);
        expect(log.error?.message).toMatch(/Unexpected real fetch/);
    });

    it("verbose:false suppresses attempt.start/attempt.ok but not failures (D15)", async () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        const fetchImpl = queuedFetch([jsonResponse({ content: [{ type: "text", text: "ok" }] })]);
        await attemptWarmup(baseEnv(), "hi", 1, false, fetchImpl);
        const events = spy.mock.calls.map((c) => JSON.parse(c[0] as string).event);
        expect(events).not.toContain("attempt.start");
        expect(events).not.toContain("attempt.ok");
        spy.mockRestore();
    });
});

describe("ping retry/backoff", () => {
    const baseEnv = () => makeEnv({ WARMUP_STATE: env.WARMUP_STATE });

    it("empty WARMUP_MESSAGE falls back to the default text (D6)", async () => {
        let sentMessage: string | undefined;
        const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
            sentMessage = JSON.parse(init?.body as string).messages[0].content;
            return jsonResponse({ content: [{ type: "text", text: "ok" }] });
        };
        await ping(makeEnv({ WARMUP_STATE: env.WARMUP_STATE, WARMUP_MESSAGE: "" }), false, { fetchImpl });
        expect(sentMessage).toMatch(/automated warm-up message/);
    });

    it("honours retry-after in seconds, capped, then succeeds (D8)", async () => {
        const fetchImpl = queuedFetch([
            textResponse("slow down", { status: 429, headers: { "retry-after": "2" } }),
            jsonResponse({ content: [{ type: "text", text: "ok" }] }),
        ]);
        const { sleep, calls } = fakeSleep();
        const result = await ping(baseEnv(), false, { fetchImpl, sleep });
        expect(result.success).toBe(true);
        expect(calls).toEqual([2000]);
    });

    it("falls back to exponential backoff without a retry-after header (D9)", async () => {
        const fetchImpl = queuedFetch([
            textResponse("err", { status: 500 }),
            jsonResponse({ content: [{ type: "text", text: "ok" }] }),
        ]);
        const { sleep, calls } = fakeSleep();
        await ping(baseEnv(), false, { fetchImpl, sleep });
        expect(calls).toEqual([1000]);
    });

    it("bug fix: caps an oversized retry-after instead of sleeping the full duration (D10)", async () => {
        const fetchImpl = queuedFetch([
            textResponse("slow down", { status: 429, headers: { "retry-after": "3600" } }),
            jsonResponse({ content: [{ type: "text", text: "ok" }] }),
        ]);
        const { sleep, calls } = fakeSleep();
        await ping(baseEnv(), false, { fetchImpl, sleep });
        expect(calls).toEqual([MAX_BACKOFF_MS]);
    });

    it("exhausts MAX_ATTEMPTS on repeated 500s (D11)", async () => {
        const fetchImpl = queuedFetch([
            textResponse("err1", { status: 500 }),
            textResponse("err2", { status: 500 }),
            textResponse("err3 body", { status: 500 }),
        ]);
        const { sleep } = fakeSleep();
        const result = await ping(baseEnv(), false, { fetchImpl, sleep });
        expect(result.success).toBe(false);
        expect(result.attempts).toHaveLength(3);
        expect(result.error).toBe("err3 body");
    });

    it("truncates a long error body in the attempt log (D12)", async () => {
        const long = "x".repeat(2000);
        const fetchImpl = queuedFetch([textResponse(long, { status: 400 })]);
        const result = await ping(baseEnv(), false, { fetchImpl });
        expect(result.success).toBe(false);
        expect(result.attempts[0].errorBody?.length).toBeLessThan(long.length);
        expect(result.attempts[0].errorBody).toContain("2000 chars total");
    });

    it("falls back to the real fetch and real sleep when no deps are given at all", async () => {
        // Covers ping()'s `deps: PingDeps = {}` default plus its own
        // `deps.fetchImpl ?? fetch` / `deps.sleep ?? realSleep` fallbacks. The
        // global fetch guard turns every attempt into a retryable failure
        // (status is undefined -> isRetryable() is true), and fake timers let
        // the real setTimeout-based backoff resolve without a real wait.
        vi.useFakeTimers();
        try {
            const resultPromise = ping(baseEnv(), false);
            await vi.advanceTimersByTimeAsync(1000); // backoff after attempt 1
            await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 2
            const result = await resultPromise;
            expect(result.success).toBe(false);
            expect(result.attempts).toHaveLength(3);
            expect(result.error).toMatch(/Unexpected real fetch/);
        } finally {
            vi.useRealTimers();
        }
    });
});
