import type { Env } from "./config";

export const STATE_KEY = "state";

export interface State {
    /** Epoch ms of the next 5h window reset, per the last observed header. */
    nextResetAt: number | null;
    /** ISO of the target slot most recently served, so we serve each slot once. */
    firedTarget: string | null;
    lastPingAt: string | null;
    lastOutcome: string | null;
}

export const EMPTY_STATE: State = {
    nextResetAt: null,
    firedTarget: null,
    lastPingAt: null,
    lastOutcome: null,
};

export async function readState(env: Env): Promise<State> {
    const stored = await env.WARMUP_STATE.get<State>(STATE_KEY, "json");
    return { ...EMPTY_STATE, ...(stored ?? {}) };
}

export async function writeState(env: Env, state: State): Promise<void> {
    await env.WARMUP_STATE.put(STATE_KEY, JSON.stringify(state));
}
