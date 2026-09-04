# claude-warmup worker

Cloudflare Worker that pings the Anthropic API on a cron trigger to reset
Claude Code's rate-limit window. Calls `api.anthropic.com` directly — no
Vercel function in the loop.

## Setup

```bash
cd worker
npm install
npx wrangler login

# The only required secret. Generate with `claude setup-token`.
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN

# Optional: enables POST /run so you can trigger a warmup on demand.
npx wrangler secret put DEBUG_TRIGGER_SECRET

npm run deploy
```

## Verifying it works

```bash
# 1. Is the token deployed?
curl https://claude-warmup.<subdomain>.workers.dev/health

# 2. Trigger a run now, without waiting ~5h for the cron.
curl -X POST https://claude-warmup.<subdomain>.workers.dev/run \
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

Useful queries once it's running:

```
event = "run.failure"          # every failed run
driftMs > 60000                # cron fired more than a minute late
```

Set `VERBOSE = "false"` in `wrangler.toml` to drop the per-attempt lines and
keep just the summary, once you're confident it works.

## Schedule

`crons = ["23 6,11,16,21 * * *"]` — every ~5 hours, off the top of the hour.
Times are UTC.
