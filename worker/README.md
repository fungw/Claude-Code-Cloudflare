# claude-warmup worker

Cloudflare Worker that opens Claude Code's 5-hour rate-limit window at
predictable times of day. Calls `api.anthropic.com` directly — no Vercel
function in the loop.

## How it decides to ping

A warm-up only opens a new window if the previous one has already expired. A
ping that lands inside an open window is silently wasted — and because a late
ping pushes the boundary later, one delay can swallow the *next* scheduled ping
too, cascading through the day. A fixed cron cannot see any of this.

So the cron ticks every 10 minutes and the Worker decides:

```
if no TARGETS_UTC slot in the last CATCHUP_HORIZON_MINUTES  -> skip
if this slot was already served                             -> skip
if the stored window reset time hasn't passed yet           -> skip, retry next tick
otherwise                                                   -> ping, store the new reset
```

The reset time is read from `anthropic-ratelimit-unified-5h-reset` on every
response, so the schedule re-anchors to the real boundary on each ping instead
of extrapolating. A late trigger costs minutes, not a window.

There is no cheap way to *check* the window: reading the header requires a
request, and a request opens a window if none is open. Hence the KV state — the
Worker remembers rather than polls. Skipped ticks cost one KV read and no API
call.

Note that 24 isn't divisible by 5. The default targets give four windows a day
with a deliberate ~9h gap overnight, in exchange for boundaries that stay put.

## Setup

```bash
cd worker
npm install
npx wrangler login

# The only required secret. Generate with `claude setup-token`.
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN

# Optional: enables POST /run so you can trigger a warmup on demand.
npx wrangler secret put DEBUG_TRIGGER_SECRET

# Create the state store, then paste the printed id into wrangler.toml
# (it replaces id = "REPLACE_ME").
npx wrangler kv namespace create WARMUP_STATE

npm run deploy
```

## Verifying it works

```bash
# 1. Is the token deployed?
curl https://claude-warmup.<subdomain>.workers.dev/health

# 2. Run the gating logic now (usually a no-op — that's the point).
curl -X POST https://claude-warmup.<subdomain>.workers.dev/run \
  -H "Authorization: Bearer $DEBUG_TRIGGER_SECRET"

# 2b. Force an actual ping, bypassing the gating. Burns a request and opens a
#     window even if one is already open — for testing the ping path only.
curl -X POST "https://claude-warmup.<subdomain>.workers.dev/run?force=1" \
  -H "Authorization: Bearer $DEBUG_TRIGGER_SECRET"

# 3. Watch logs live (also test the cron path locally with `wrangler dev --test-scheduled`)
npm run tail
```

Logs are also persisted to Workers Logs (`[observability]` in `wrangler.toml`),
so you can browse past cron runs in the dashboard rather than needing `tail`
open at the moment it fires.

## What gets logged

One JSON line per event. The `run.success` / `run.failure` summary carries:

| Field | Why it's there |
|---|---|
| `runId` | Correlates the attempt lines with the summary |
| `scheduledAt` | When the cron was **due** |
| `startedAt` | When the Worker **actually** ran |
| `driftMs` | The gap between those two — the GitHub Actions problem, now measured |
| `finishedAt` / `totalMs` | Wall-clock cost of the whole run |
| `url` / `model` | Exactly what was hit |
| `tokenFingerprint` | `len=… …abcd`, to confirm *which* token is deployed |
| `attempts[]` | Per-try status, duration, and error body |
| `attempts[].headers` | Anthropic's `request-id` and `anthropic-ratelimit-*` state |
| `attempts[].usage` | Token counts from the response |
| `reply` | What Claude actually said |
| `targetSlot` / `minutesSinceTarget` | Which slot this tick was serving, and how late |
| `knownResetAt` / `minutesUntilReset` | The window boundary the Worker is gating on |
| `newResetAt` / `newResetSource` | Boundary after the ping; `header` or `fallback:+5h` |
| `rateLimit` | Full `anthropic-ratelimit-*` set, incl. 5h/7d utilization |
| `reason` (on `run.skipped`) | `no-target`, `already-served`, `window-still-open` |

Useful queries once it's running:

```
event = "run.failure"                 # every failed run
event = "run.skipped" AND reason = "window-still-open"
                                      # gating did its job; a fixed cron would
                                      # have wasted this slot
minutesSinceTarget > 30               # slots being served late
newResetSource = "fallback:+5h"       # the reset header stopped being sent
```

Watch `rateLimit["anthropic-ratelimit-unified-7d-utilization"]` too — it's how
you'd notice the warmups eating into the weekly budget.

Set `VERBOSE = "false"` in `wrangler.toml` to drop the per-attempt lines and
keep just the summary, once you're confident it works.

## Schedule

`crons = ["*/10 * * * *"]` — ticks every 10 minutes; the Worker gates the
actual pings. Change *when* windows open via `TARGETS_UTC` in `wrangler.toml`
(default `06:00,11:00,16:00,21:00`), not via the cron.

`CATCHUP_HORIZON_MINUTES` (default 240) is how long after a target the Worker
keeps retrying if the previous window is still open. Keep it below the gap
between targets.
