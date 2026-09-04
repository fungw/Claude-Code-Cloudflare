import type { Env } from "./config";
import { resolveConfig } from "./config";
import { currentTarget } from "./schedule";
import { readState, writeState, type State } from "./state";
import { ANTHROPIC_API_URL, MODEL, resetFromHeaders, ping, type PingDeps } from "./anthropic";
import { emit, fingerprint } from "./log";

export type SkipReason = "no-target" | "already-served" | "window-still-open";

export interface TickOptions {
    trigger: "cron" | "manual";
    cron: string | null;
    scheduledTime: number | null;
    /** Manual runs may bypass the gating, to test the ping path on demand. */
    force?: boolean;
}

export interface TickDeps extends PingDeps {
    now?: () => Date;
}

export async function tick(env: Env, opts: TickOptions, deps: TickDeps = {}) {
    const now = deps.now ?? (() => new Date());
    const runId = crypto.randomUUID();
    const started = now();

    const configResult = resolveConfig(env);

    const clockBase = {
        runId,
        trigger: opts.trigger,
        cron: opts.cron,
        scheduledAt: opts.scheduledTime === null ? null : new Date(opts.scheduledTime).toISOString(),
        startedAt: started.toISOString(),
        /** Positive = the platform fired us late. Gating means this is now survivable. */
        driftMs: opts.scheduledTime === null ? null : started.getTime() - opts.scheduledTime,
    };

    // Bug fix: a bad TARGETS_LOCAL used to throw straight out of this function,
    // dying as an unhandled rejection inside ctx.waitUntil with no application
    // log line. Report it through the normal channel instead.
    if (!configResult.ok) {
        const report = {
            ...clockBase,
            targetSlot: null,
            minutesSinceTarget: null,
            action: "failed" as const,
            success: false,
            error: `Invalid configuration: ${configResult.error}`,
        };
        emit("run.failure", report);
        return report;
    }

    const { config } = configResult;
    const target = currentTarget(started, config.targets, config.timeZone, config.horizonMs);

    // Whether a slot is due depends only on the clock, so answer that before
    // touching KV. Most ticks of the day end here, at zero storage cost.
    const clockBaseWithTarget = {
        ...clockBase,
        targetSlot: target?.toISOString() ?? null,
        minutesSinceTarget: target ? Math.round((started.getTime() - target.getTime()) / 60_000) : null,
    };

    if (!opts.force && !target) {
        // State fields are absent rather than null here: KV was never read.
        if (config.verbose) emit("run.skipped", { ...clockBaseWithTarget, reason: "no-target" });
        return { ...clockBaseWithTarget, action: "skipped" as const, reason: "no-target" as const, success: true };
    }

    const state = await readState(env);

    const base = {
        ...clockBaseWithTarget,
        knownResetAt: state.nextResetAt === null ? null : new Date(state.nextResetAt).toISOString(),
        minutesUntilReset:
            state.nextResetAt === null ? null : Math.round((state.nextResetAt - started.getTime()) / 60_000),
        firedTarget: state.firedTarget,
    };

    const skip = (reason: SkipReason) => {
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

    const result = await ping(env, config.verbose, deps);
    const finished = now();

    let newReset: { at: number; source: string } | null = null;
    if (result.success) {
        newReset = resetFromHeaders(result.headers, finished.getTime());
        // Only mark the slot served on success, so a failure retries next tick.
        await writeState(env, {
            nextResetAt: newReset.at,
            firedTarget: target?.toISOString() ?? state.firedTarget,
            lastPingAt: finished.toISOString(),
            lastOutcome: "success",
        } satisfies State);
    } else {
        await writeState(env, { ...state, lastPingAt: finished.toISOString(), lastOutcome: "failure" } satisfies State);
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
