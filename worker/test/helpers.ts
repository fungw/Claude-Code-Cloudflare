import type { Env } from "../src/config";

/** A minimal, overridable Env. `WARMUP_STATE` must be supplied by the caller (usually the real test KV). */
export function makeEnv(overrides: Partial<Env> & Pick<Env, "WARMUP_STATE">): Env {
    return {
        CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        ...overrides,
    };
}

/** A `Response`-returning stand-in for `fetch`, queued call by call. */
export function queuedFetch(responses: Array<Response | (() => Response) | (() => Promise<Response>)>) {
    let i = 0;
    return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        if (i >= responses.length) {
            throw new Error(`queuedFetch: called ${i + 1} times but only ${responses.length} responses queued`);
        }
        const entry = responses[i++];
        return typeof entry === "function" ? await entry() : entry;
    };
}

export function jsonResponse(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
    return new Response(JSON.stringify(body), {
        status: 200,
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
}

export function textResponse(text: string, init: ResponseInit & { headers?: Record<string, string> } = {}) {
    return new Response(text, {
        status: init.status ?? 500,
        ...init,
        headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
    });
}

/** A no-op sleeper that resolves immediately, recording requested delays. */
export function fakeSleep() {
    const calls: number[] = [];
    const sleep = async (ms: number) => {
        calls.push(ms);
    };
    return { sleep, calls };
}

/** A fixed clock for `TickDeps.now` / schedule tests. */
export function fixedNow(iso: string): () => Date {
    const date = new Date(iso);
    return () => date;
}
