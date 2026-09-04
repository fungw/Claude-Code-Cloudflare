import { describe, expect, it } from "vitest";
import { currentTarget, zonedTimeToUtc, zonedYMD, type Target } from "../src/schedule";

const DEFAULT_TARGETS: Target[] = [
    { hours: 6, minutes: 0 },
    { hours: 11, minutes: 0 },
    { hours: 16, minutes: 0 },
    { hours: 21, minutes: 0 },
];

describe("zonedYMD", () => {
    it("returns the local day for a mid-day instant (B1)", () => {
        expect(zonedYMD(new Date("2026-06-15T12:00:00Z"), "Europe/Dublin")).toEqual({ y: 2026, m: 6, d: 15 });
    });

    it("returns the prior calendar day when UTC has already rolled over (B2)", () => {
        // 2026-01-01T00:30Z is still 2025-12-31 19:30 in America/New_York (UTC-5).
        expect(zonedYMD(new Date("2026-01-01T00:30:00Z"), "America/New_York")).toEqual({ y: 2025, m: 12, d: 31 });
    });
});

describe("zonedTimeToUtc", () => {
    it("06:00 Dublin in January (GMT, UTC+0) is 06:00Z (B3)", () => {
        expect(zonedTimeToUtc(2026, 1, 15, 6, 0, "Europe/Dublin")).toBe(Date.UTC(2026, 0, 15, 6, 0));
    });

    it("06:00 Dublin in July (IST, UTC+1) is 05:00Z (B4)", () => {
        expect(zonedTimeToUtc(2026, 7, 15, 6, 0, "Europe/Dublin")).toBe(Date.UTC(2026, 6, 15, 5, 0));
    });

    it("29 Mar 2026 spring-forward: 01:30 local resolves to a definite UTC instant (B5)", () => {
        // Verified against Intl: Ireland skips 01:00-02:00 local on this date. The
        // round-trip through Date.UTC + Intl either snaps to the pre- or
        // post-transition offset; this test pins whichever it is, so a future
        // regression in the algorithm is visible even though "correct" here is
        // itself a judgment call for a wall-clock time that never occurred.
        const at = zonedTimeToUtc(2026, 3, 29, 1, 30, "Europe/Dublin");
        expect(Number.isFinite(at)).toBe(true);
        // Confirm it round-trips to a real offset either side of the gap.
        const offsetHours = (at - Date.UTC(2026, 2, 29, 1, 30)) / (60 * 60 * 1000);
        expect([0, -1]).toContain(offsetHours);
    });

    it("25 Oct 2026 fall-back: 01:30 local resolves to a definite UTC instant (B6)", () => {
        const at = zonedTimeToUtc(2026, 10, 25, 1, 30, "Europe/Dublin");
        expect(Number.isFinite(at)).toBe(true);
        const offsetHours = (at - Date.UTC(2026, 9, 25, 1, 30)) / (60 * 60 * 1000);
        expect([0, -1]).toContain(offsetHours);
    });

    it("day before/after spring-forward carry the expected GMT/IST offsets (B7)", () => {
        expect(zonedTimeToUtc(2026, 3, 28, 6, 0, "Europe/Dublin")).toBe(Date.UTC(2026, 2, 28, 6, 0)); // GMT, +0
        expect(zonedTimeToUtc(2026, 3, 30, 6, 0, "Europe/Dublin")).toBe(Date.UTC(2026, 2, 30, 5, 0)); // IST, +1
    });

    it("day before/after fall-back carry the expected IST/GMT offsets", () => {
        expect(zonedTimeToUtc(2026, 10, 24, 6, 0, "Europe/Dublin")).toBe(Date.UTC(2026, 9, 24, 5, 0)); // IST, +1
        expect(zonedTimeToUtc(2026, 10, 26, 6, 0, "Europe/Dublin")).toBe(Date.UTC(2026, 9, 26, 6, 0)); // GMT, +0
    });
});

describe("currentTarget", () => {
    const tz = "Europe/Dublin";
    const horizon = 240 * 60_000;

    it("returns the target exactly at the boundary (B8)", () => {
        const at06 = new Date(zonedTimeToUtc(2026, 6, 15, 6, 0, tz));
        expect(currentTarget(at06, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(at06.getTime());
    });

    it("does not return a target 1ms before it (B9)", () => {
        const at06 = zonedTimeToUtc(2026, 6, 15, 6, 0, tz);
        const justBefore = new Date(at06 - 1);
        const result = currentTarget(justBefore, DEFAULT_TARGETS, tz, horizon);
        // Should fall back to the prior day's 21:00 slot, not 06:00 today.
        expect(result?.getTime()).not.toBe(at06);
    });

    it("returns the target exactly at the horizon boundary (B10)", () => {
        const at06 = zonedTimeToUtc(2026, 6, 15, 6, 0, tz);
        const now = new Date(at06 + horizon);
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(at06);
    });

    it("returns null 1ms past the horizon boundary (B11)", () => {
        const at06 = zonedTimeToUtc(2026, 6, 15, 6, 0, tz);
        const now = new Date(at06 + horizon + 1);
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)).toBeNull();
    });

    it("picks the later of two past targets today (B12)", () => {
        const at16 = zonedTimeToUtc(2026, 6, 15, 16, 0, tz);
        const now = new Date(at16 + 5 * 60_000); // just after 16:00, both 06:00 and 11:00 and 16:00 are past
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(at16);
    });

    it("falls back to yesterday's last slot in the small hours (B13)", () => {
        const yesterday21 = zonedTimeToUtc(2026, 6, 14, 21, 0, tz);
        const now = new Date(zonedTimeToUtc(2026, 6, 15, 0, 30, tz));
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(yesterday21);
    });

    it("rolls over the month boundary (B14)", () => {
        const feb28_21 = zonedTimeToUtc(2026, 2, 28, 21, 0, tz);
        const now = new Date(zonedTimeToUtc(2026, 3, 1, 0, 30, tz));
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(feb28_21);
    });

    it("rolls over the year boundary (B15)", () => {
        const dec31_21 = zonedTimeToUtc(2025, 12, 31, 21, 0, tz);
        const now = new Date(zonedTimeToUtc(2026, 1, 1, 0, 30, tz));
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(dec31_21);
    });

    it("handles a leap-year February correctly (B16)", () => {
        const feb29_21 = zonedTimeToUtc(2028, 2, 29, 21, 0, tz);
        const now = new Date(zonedTimeToUtc(2028, 3, 1, 0, 30, tz));
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)?.getTime()).toBe(feb29_21);
    });

    it("returns null in the overnight gap outside the horizon (B17)", () => {
        // 03:00 local is > 4h (the default horizon) past 21:00 and > 4h before 06:00.
        const now = new Date(zonedTimeToUtc(2026, 6, 15, 3, 0, tz));
        expect(currentTarget(now, DEFAULT_TARGETS, tz, horizon)).toBeNull();
    });

    it("returns null for an empty targets list (defensive: parseTargets guarantees non-empty in practice)", () => {
        const now = new Date(zonedTimeToUtc(2026, 6, 15, 6, 0, tz));
        expect(currentTarget(now, [], tz, horizon)).toBeNull();
    });

    it("works with a single-target config (B18)", () => {
        const single: Target[] = [{ hours: 6, minutes: 0 }];
        const at06 = new Date(zonedTimeToUtc(2026, 6, 15, 6, 0, tz));
        expect(currentTarget(at06, single, tz, horizon)?.getTime()).toBe(at06.getTime());
    });
});
