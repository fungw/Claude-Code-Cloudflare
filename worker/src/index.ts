/**
 * Scheduled warm-up ping to the Anthropic API, to open Claude Code's
 * 5-hour rate-limit window at predictable times of day.
 *
 * Why this is more than a cron: a warm-up ping only opens a new window if the
 * previous one has already expired. A ping that lands inside an open window is
 * silently wasted, and a fixed cron has no way to know. Worse, one late ping
 * shifts the window boundary later, which can swallow the *next* scheduled
 * ping too — so a single delay cascades through the rest of the day.
 *
 * So instead of pinging on a fixed schedule, we tick often and gate each ping
 * on the window state:
 *
 *   - The API reports `anthropic-ratelimit-unified-5h-reset` on every response.
 *     That is the authoritative window boundary; we persist it to KV.
 *   - Each tick pings only if (a) we are inside the catch-up horizon after one
 *     of the TARGETS_UTC times, (b) that target hasn't been served yet, and
 *     (c) the stored reset time has passed.
 *   - Otherwise the tick does nothing and costs no API call.
 *
 * Note there is no way to *check* the window cheaply: reading the reset header
 * requires a request, and a request opens a window if none is open. Hence the
 * stored reset time — we remember rather than poll.
 *
 * A late tick therefore costs minutes, not a whole window, and the schedule
 * re-anchors to the real boundary on every ping rather than accumulating drift.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 30_000;
const STATE_KEY = "state";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const DEFAULT_TARGETS = "06:00,11:00,16:00,21:00";
/** How long after a target we keep retrying before giving that slot up. Must be < the gap between targets. */
const DEFAULT_HORIZON_MINUTES = 240;

const DEFAULT_WARMUP_MESSAGE =
    "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

interface Env {
    WARMUP_STATE: KVNamespace;
    CLAUDE_CODE_OAUTH_TOKEN: string;
    WARMUP_MESSAGE?: string;
    /** Comma-separated UTC times, e.g. "06:00,11:00,16:00,21:00". */
    TARGETS_UTC?: string;
    CATCHUP_HORIZON_MINUTES?: string;
    /** Optional. When set, enables the manual POST /run trigger. */
    DEBUG_TRIGGER_SECRET?: string;
    VERBOSE?: string;
}

interface State {
    /** Epoch ms of the next 5h window reset, per the last observed header. */
    nextResetAt: number | null;
    /** ISO of the target slot most recently served, so we serve each slot once. */
    firedTarget: string | null;
    lastPingAt: string | null;
    lastOutcome: string | null;
}

const EMPTY_STATE: State = {
    nextResetAt: null,
    firedTarget: null,
    lastPingAt: null,
    lastOutcome: null,
};

interface AttemptLog {
    attempt: number;
    startedAt: string;
    durationMs: number;
    status?: number;
    statusText?: string;
    ok: boolean;
    headers?: Record<string, string>;
    usage?: unknown;
    error?: { name: string; message: string };
    errorBody?: string;
}

type SkipReason = "no-target" | "already-served" | "window-still-open";

function emit(event: string, fields: object) {
    console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

function fingerprint(token: string | undefined): string {
    if (!token) return "absent";
    return `len=${token.length} …${token.slice(-4)}`;
}

/**
 * Keep every rate-limit header the API sends, rather than a fixed allowlist —
 * the `unified-*` family was missed once already by guessing at names.
 */
function pickHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    res.headers.forEach((value, name) => {
        if (name.startsWith("anthropic-ratelimit") || name === "request-id" || name === "retry-after") {
            out[name] = value;
        }
    });
    return out;
}

function truncate(text: string, max = 1000): string {
    return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars total)`;
}

function isRetryable(status: number | undefined): boolean {
    if (status === undefined) return true; // network error or timeout
    return status === 408 || status === 429 || status >= 500;
}

/** The window boundary the API just told us about. Falls back to now + 5h if absent. */
function resetFromHeaders(headers: Record<string, string>, now: number): { at: number; source: string } {
    const raw = headers["anthropic-ratelimit-unified-5h-reset"];
    const seconds = Number(raw);
    if (raw !== undefined && Number.isFinite(seconds) && seconds > 0) {
        return { at: seconds * 1000, source: "header" };
    }
    return { at: now + FIVE_HOURS_MS, source: "fallback:+5h" };
}

function parseTargets(raw: string): number[] {
    const targets: number[] = [];
    for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const [h, m = "0"] = trimmed.split(":");
        const hours = Number(h);
        const minutes = Number(m);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
            throw new Error(`Invalid entry "${trimmed}" in TARGETS_UTC`);
        }
        targets.push(hours * 60 + minutes);
    }
    if (targets.length === 0) throw new Error("TARGETS_UTC is empty");
    return targets.sort((a, b) => a - b);
}

/**
 * The most recent target slot at or before `now`, if we're still within the
 * catch-up horizon for it. Null means this tick has no slot to serve.
 */
function currentTarget(now: Date, targetMinutes: number[], horizonMs: number): Date | null {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let best: number | null = null;

    // Yesterday's slots matter for a late-night target with a long horizon.
    for (const dayOffset of [-1, 0]) {
        for (const minutes of targetMinutes) {
            const at = midnight + dayOffset * 86_400_000 + minutes * 60_000;
            if (at <= now.getTime() && (best === null || at > best)) best = at;
        }
    }

    if (best === null) return null;
    return now.getTime() - best <= horizonMs ? new Date(best) : null;
}

async function readState(env: Env): Promise<State> {
    const stored = await env.WARMUP_STATE.get<State>(STATE_KEY, "json");
    return { ...EMPTY_STATE, ...(stored ?? {}) };
}

async function attemptWarmup(
    env: Env,
    message: string,
    attempt: number,
    verbose: boolean
): Promise<{ log: AttemptLog; reply?: string }> {
    const startedAt = new Date();
    const t0 = Date.now();

    if (verbose) {
        emit("attempt.start", { attempt, url: ANTHROPIC_API_URL, model: MODEL, messageChars: message.length });
    }

    try {
        const response = await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`,
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 64,
                messages: [{ role: "user", content: message }],
            }),
            signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });

        const headers = pickHeaders(response);

        if (!response.ok) {
            const log: AttemptLog = {
                attempt,
                startedAt: startedAt.toISOString(),
                durationMs: Date.now() - t0,
                status: response.status,
                statusText: response.statusText,
                ok: false,
                headers,
                errorBody: truncate(await response.text()),
            };
            emit("attempt.failed", log);
            return { log };
        }

        const data = (await response.json()) as {
            content?: Array<{ type: string; text?: string }>;
            usage?: unknown;
        };
        const reply = data.content?.find((b) => b.type === "text")?.text ?? "(no text block)";

        const log: AttemptLog = {
            attempt,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - t0,
            status: response.status,
            statusText: response.statusText,
            ok: true,
            headers,
            usage: data.usage,
        };
        if (verbose) emit("attempt.ok", { ...log, reply });
        return { log, reply };
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const log: AttemptLog = {
            attempt,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - t0,
            ok: false,
            error: { name: error.name, message: error.message },
        };
        emit("attempt.error", log);
        return { log };
    }
}

async function ping(env: Env, verbose: boolean) {
    const message = env.WARMUP_MESSAGE || DEFAULT_WARMUP_MESSAGE;
    const attempts: AttemptLog[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { log, reply } = await attemptWarmup(env, message, attempt, verbose);
        attempts.push(log);

        if (log.ok) return { success: true as const, attempts, reply, headers: log.headers ?? {} };

        if (!isRetryable(log.status) || attempt === MAX_ATTEMPTS) {
            return {
                success: false as const,
                attempts,
                error: log.errorBody ?? log.error?.message ?? `HTTP ${log.status ?? "?"}`,
            };
        }

        const retryAfter = Number(log.headers?.["retry-after"]);
        const backoffMs =
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        emit("attempt.retrying", { attempt, backoffMs });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    return { success: false as const, attempts, error: "exhausted attempts" };
}

interface TickOptions {
    trigger: "cron" | "manual";
    cron: string | null;
    scheduledTime: number | null;
    /** Manual runs may bypass the gating, to test the ping path on demand. */
    force?: boolean;
}

async function tick(env: Env, opts: TickOptions) {
    const runId = crypto.randomUUID();
    const started = new Date();
    const verbose = env.VERBOSE !== "false";
    const horizonMs =
        Number(env.CATCHUP_HORIZON_MINUTES ?? DEFAULT_HORIZON_MINUTES) * 60_000;

    const targets = parseTargets(env.TARGETS_UTC || DEFAULT_TARGETS);
    const target = currentTarget(started, targets, horizonMs);

    // Whether a slot is due depends only on the clock, so answer that before
    // touching KV. Most ticks of the day end here, at zero storage cost.
    const clockBase = {
        runId,
        trigger: opts.trigger,
        cron: opts.cron,
        scheduledAt: opts.scheduledTime === null ? null : new Date(opts.scheduledTime).toISOString(),
        startedAt: started.toISOString(),
        /** Positive = the platform fired us late. Gating means this is now survivable. */
        driftMs: opts.scheduledTime === null ? null : started.getTime() - opts.scheduledTime,
        targetSlot: target?.toISOString() ?? null,
        minutesSinceTarget: target ? Math.round((started.getTime() - target.getTime()) / 60_000) : null,
    };

    if (!opts.force && !target) {
        // State fields are absent rather than null here: KV was never read.
        if (verbose) emit("run.skipped", { ...clockBase, reason: "no-target" });
        return { ...clockBase, action: "skipped" as const, reason: "no-target" as const, success: true };
    }

    const state = await readState(env);

    const base = {
        ...clockBase,
        knownResetAt: state.nextResetAt === null ? null : new Date(state.nextResetAt).toISOString(),
        minutesUntilReset:
            state.nextResetAt === null ? null : Math.round((state.nextResetAt - started.getTime()) / 60_000),
        firedTarget: state.firedTarget,
    };

    const skip = async (reason: SkipReason) => {
        emit("run.skipped", { ...base, reason });
        return { ...base, action: "skipped" as const, reason, success: true };
    };

    if (!opts.force && target) {
        if (state.firedTarget === target.toISOString()) return skip("already-served");
        // The decisive check: a ping inside an open window would be wasted.
        if (state.nextResetAt !== null && started.getTime() < state.nextResetAt) {
            return skip("window-still-open");
        }
    }

    emit("run.start", {
        ...base,
        forced: Boolean(opts.force),
        url: ANTHROPIC_API_URL,
        model: MODEL,
        tokenFingerprint: fingerprint(env.CLAUDE_CODE_OAUTH_TOKEN),
    });

    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
        const report = {
            ...base,
            action: "pinged" as const,
            success: false,
            error: "CLAUDE_CODE_OAUTH_TOKEN is not set. Run `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN`.",
        };
        emit("run.failure", report);
        return report;
    }

    const result = await ping(env, verbose);
    const finished = new Date();

    let newReset: { at: number; source: string } | null = null;
    if (result.success) {
        newReset = resetFromHeaders(result.headers, finished.getTime());
        // Only mark the slot served on success, so a failure retries next tick.
        await env.WARMUP_STATE.put(
            STATE_KEY,
            JSON.stringify({
                nextResetAt: newReset.at,
                firedTarget: target?.toISOString() ?? state.firedTarget,
                lastPingAt: finished.toISOString(),
                lastOutcome: "success",
            } satisfies State)
        );
    } else {
        await env.WARMUP_STATE.put(
            STATE_KEY,
            JSON.stringify({ ...state, lastPingAt: finished.toISOString(), lastOutcome: "failure" } satisfies State)
        );
    }

    const report = {
        ...base,
        action: "pinged" as const,
        finishedAt: finished.toISOString(),
        totalMs: finished.getTime() - started.getTime(),
        success: result.success,
        attempts: result.attempts,
        reply: result.success ? result.reply : undefined,
        error: result.success ? undefined : result.error,
        newResetAt: newReset ? new Date(newReset.at).toISOString() : null,
        newResetSource: newReset?.source ?? null,
        rateLimit: result.success ? result.headers : undefined,
    };

    emit(result.success ? "run.success" : "run.failure", report);
    return report;
}

export default {
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(
            tick(env, { trigger: "cron", cron: controller.cron, scheduledTime: controller.scheduledTime })
        );
    },

    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
            const state = await readState(env);
            const now = new Date();
            const targets = parseTargets(env.TARGETS_UTC || DEFAULT_TARGETS);
            const horizonMs = Number(env.CATCHUP_HORIZON_MINUTES ?? DEFAULT_HORIZON_MINUTES) * 60_000;
            return Response.json({
                ok: true,
                now: now.toISOString(),
                targetsUtc: env.TARGETS_UTC || DEFAULT_TARGETS,
                catchupHorizonMinutes: horizonMs / 60_000,
                currentTargetSlot: currentTarget(now, targets, horizonMs)?.toISOString() ?? null,
                tokenConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
                manualTriggerEnabled: Boolean(env.DEBUG_TRIGGER_SECRET),
                state: {
                    ...state,
                    nextResetAtIso:
                        state.nextResetAt === null ? null : new Date(state.nextResetAt).toISOString(),
                    minutesUntilReset:
                        state.nextResetAt === null
                            ? null
                            : Math.round((state.nextResetAt - now.getTime()) / 60_000),
                },
            });
        }

        if (url.pathname !== "/run") {
            return new Response("Not found. Try /health or POST /run.", { status: 404 });
        }

        if (!env.DEBUG_TRIGGER_SECRET) {
            return Response.json(
                { error: "Manual trigger disabled. Set DEBUG_TRIGGER_SECRET to enable." },
                { status: 403 }
            );
        }
        if (request.headers.get("authorization") !== `Bearer ${env.DEBUG_TRIGGER_SECRET}`) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // ?force=1 bypasses gating — useful for testing the ping path, but it
        // will burn a request inside an already-open window.
        const report = await tick(env, {
            trigger: "manual",
            cron: null,
            scheduledTime: null,
            force: url.searchParams.get("force") === "1",
        });
        return Response.json(report, { status: report.success ? 200 : 500 });
    },
};
