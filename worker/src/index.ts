/**
 * Scheduled warm-up ping to the Anthropic API, to reset Claude Code's
 * rate-limit window. Runs on a Cloudflare cron trigger.
 *
 * Every run emits structured single-line JSON to Workers Logs. While
 * VERBOSE is "true" that includes per-attempt request/response detail;
 * the summary line is always emitted.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 30_000;

const DEFAULT_WARMUP_MESSAGE =
    "Hello! This is an automated warm-up message to reset my Claude Code rate limit window. Please just say 'Warmed up!' in response.";

/** Anthropic response headers worth keeping — rate-limit state and the id to quote in support requests. */
const INTERESTING_HEADERS = [
    "request-id",
    "retry-after",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-input-tokens-remaining",
    "anthropic-ratelimit-output-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
];

interface Env {
    CLAUDE_CODE_OAUTH_TOKEN: string;
    WARMUP_MESSAGE?: string;
    /** Optional. When set, enables the manual POST /run trigger. */
    DEBUG_TRIGGER_SECRET?: string;
    VERBOSE?: string;
}

type Trigger = "cron" | "manual";

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
    /** Only populated on failure — the API's error body, truncated. */
    errorBody?: string;
}

interface RunReport {
    runId: string;
    trigger: Trigger;
    cron: string | null;
    /** When the cron was due to fire. Null for manual runs. */
    scheduledAt: string | null;
    /** When the Worker actually started. scheduledAt vs this is scheduler drift. */
    startedAt: string;
    finishedAt: string;
    /** Positive = the platform fired us late. This is the number to watch. */
    driftMs: number | null;
    totalMs: number;
    url: string;
    model: string;
    /** Last 4 chars only — enough to tell which token is deployed, useless if leaked. */
    tokenFingerprint: string;
    messageChars: number;
    success: boolean;
    attempts: AttemptLog[];
    reply?: string;
    error?: string;
}

function emit(event: string, fields: object) {
    console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

function fingerprint(token: string | undefined): string {
    if (!token) return "absent";
    return `len=${token.length} …${token.slice(-4)}`;
}

function pickHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of INTERESTING_HEADERS) {
        const value = res.headers.get(name);
        if (value !== null) out[name] = value;
    }
    return out;
}

function truncate(text: string, max = 1000): string {
    return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars total)`;
}

/** Retry on transient failures only: rate limits, server errors, network/timeout. */
function isRetryable(status: number | undefined): boolean {
    if (status === undefined) return true; // network error or timeout
    return status === 408 || status === 429 || status >= 500;
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
        emit("attempt.start", {
            attempt,
            url: ANTHROPIC_API_URL,
            model: MODEL,
            messageChars: message.length,
        });
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
            const errorBody = truncate(await response.text());
            const log: AttemptLog = {
                attempt,
                startedAt: startedAt.toISOString(),
                durationMs: Date.now() - t0,
                status: response.status,
                statusText: response.statusText,
                ok: false,
                headers,
                errorBody,
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

async function runWarmup(
    env: Env,
    trigger: Trigger,
    cron: string | null,
    scheduledTime: number | null
): Promise<RunReport> {
    const runId = crypto.randomUUID();
    const started = new Date();
    const verbose = env.VERBOSE !== "false";
    const message = env.WARMUP_MESSAGE || DEFAULT_WARMUP_MESSAGE;

    const report: RunReport = {
        runId,
        trigger,
        cron,
        scheduledAt: scheduledTime === null ? null : new Date(scheduledTime).toISOString(),
        startedAt: started.toISOString(),
        finishedAt: started.toISOString(),
        driftMs: scheduledTime === null ? null : started.getTime() - scheduledTime,
        totalMs: 0,
        url: ANTHROPIC_API_URL,
        model: MODEL,
        tokenFingerprint: fingerprint(env.CLAUDE_CODE_OAUTH_TOKEN),
        messageChars: message.length,
        success: false,
        attempts: [],
    };

    emit("run.start", {
        runId,
        trigger,
        cron,
        scheduledAt: report.scheduledAt,
        startedAt: report.startedAt,
        driftMs: report.driftMs,
        url: report.url,
        model: report.model,
        tokenFingerprint: report.tokenFingerprint,
    });

    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
        report.error =
            "CLAUDE_CODE_OAUTH_TOKEN is not set. Run `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN`.";
    } else {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const { log, reply } = await attemptWarmup(env, message, attempt, verbose);
            report.attempts.push(log);

            if (log.ok) {
                report.success = true;
                report.reply = reply;
                break;
            }

            if (!isRetryable(log.status) || attempt === MAX_ATTEMPTS) {
                report.error =
                    log.errorBody ?? log.error?.message ?? `HTTP ${log.status ?? "?"}`;
                break;
            }

            // Honour Retry-After when the API sends one, else exponential backoff.
            const retryAfter = Number(log.headers?.["retry-after"]);
            const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 1000 * 2 ** (attempt - 1);
            emit("attempt.retrying", { runId, attempt, backoffMs });
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }

    const finished = new Date();
    report.finishedAt = finished.toISOString();
    report.totalMs = finished.getTime() - started.getTime();

    emit(report.success ? "run.success" : "run.failure", report);
    return report;
}

export default {
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(
            runWarmup(env, "cron", controller.cron, controller.scheduledTime)
        );
    },

    /**
     * Manual trigger, for debugging without waiting for the next cron.
     * Requires DEBUG_TRIGGER_SECRET to be set, and matched via
     * `Authorization: Bearer <secret>`. Returns the full run report.
     */
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
            return Response.json({
                ok: true,
                now: new Date().toISOString(),
                tokenConfigured: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
                manualTriggerEnabled: Boolean(env.DEBUG_TRIGGER_SECRET),
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

        const report = await runWarmup(env, "manual", null, null);
        return Response.json(report, { status: report.success ? 200 : 500 });
    },
};
