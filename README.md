# 🔥 Claude Code CloudFlare-Up

> Automatically warm up your Claude Code rate limit window so it resets right before your work session.

---

## The Problem

Claude Code's rate limits work on a **rolling 5-hour window** — the clock starts from your **first request**, not midnight. So if you sleep in and start at noon, you get a short window for the day.

**Solution:** Send a tiny warm-up message a few hours before you plan to work. The 5-hour window starts then, resets before you begin, and you get full quota.

---

## How It Works

This runs as a **Cloudflare Worker** (see [`worker/`](worker/)) rather than a Vercel function or GitHub Actions cron:

1. The Worker ticks every 10 minutes and checks whether it's near one of your configured local target times (e.g. 6 AM)
2. It pings the Anthropic API directly with your `CLAUDE_CODE_OAUTH_TOKEN`
3. It reads the `anthropic-ratelimit-unified-5h-reset` header from the response — the authoritative window boundary — and stores it, so a late or duplicate tick never wastes a ping inside an already-open window
4. Your 5-hour window starts ticking → resets before your workday begins ✅

Full setup, configuration, and the gating design are documented in [`worker/README.md`](worker/README.md).

---

## License

MIT
