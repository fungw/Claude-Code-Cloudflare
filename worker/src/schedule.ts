/** Target-slot arithmetic: local wall-clock times, resolved against a DST-aware IANA zone. */

export interface Target {
    hours: number;
    minutes: number;
}

/** The Y/M/D that `date` falls on inside `timeZone`. */
export function zonedYMD(date: Date, timeZone: string): { y: number; m: number; d: number } {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * The UTC instant corresponding to a wall-clock date/time in `timeZone`.
 * Resolves the zone's actual offset for that date via Intl, so it tracks DST
 * automatically rather than needing the config updated when clocks change.
 */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asZoned = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return guess - (asZoned - guess);
}

/**
 * The most recent target slot at or before `now`, if we're still within the
 * catch-up horizon for it. Null means this tick has no slot to serve.
 */
export function currentTarget(now: Date, targets: Target[], timeZone: string, horizonMs: number): Date | null {
    const today = zonedYMD(now, timeZone);
    let best: number | null = null;

    // Yesterday's slot matters for a late-night target with a long horizon.
    // Date.UTC normalizes day 0 into the previous month for us.
    for (const dayOffset of [-1, 0]) {
        const shifted = new Date(Date.UTC(today.y, today.m - 1, today.d + dayOffset));
        const y = shifted.getUTCFullYear();
        const m = shifted.getUTCMonth() + 1;
        const d = shifted.getUTCDate();
        for (const { hours, minutes } of targets) {
            const at = zonedTimeToUtc(y, m, d, hours, minutes, timeZone);
            if (at <= now.getTime() && (best === null || at > best)) best = at;
        }
    }

    if (best === null) return null;
    return now.getTime() - best <= horizonMs ? new Date(best) : null;
}
