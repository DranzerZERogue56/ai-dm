# Deploy guide — AI-DM

Production shape:

- **Frontend** → Cloudflare Pages (static)
- **Worker + Durable Object** → Cloudflare Workers
- **Postgres** → Neon (canonical store; codex, chat, invites)
- **Hyperdrive** → connection pool between Worker and Neon
- **Agent** → your home machine (uses Claude Code `/login` subscription auth — $0 inference)

Whole stack costs ~$0/month for a weekly home game. The only running cost is your Claude Code subscription, which you already pay.

---

## Prerequisites

1. **Cloudflare account** (free): https://dash.cloudflare.com
2. **Neon account** (free tier): https://neon.tech
3. **`wrangler` CLI** logged in: `cd worker && npx wrangler login`
4. **psql** installed locally to run the migration
5. Your Claude Code subscription is logged in on your home machine (`claude /login` once)

---

## Step 1 — Neon project + migration

```bash
# Create a project at https://console.neon.tech, then copy the connection string.
# Looks like: postgres://USER:PASS@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# Save it locally for this terminal:
export DATABASE_URL="postgres://...?sslmode=require"

# Run the migration:
psql "$DATABASE_URL" -f worker/drizzle/0000_init.sql
```

Verify:

```bash
psql "$DATABASE_URL" -c "\dt"
# expect: campaigns, codex_entries, invites, chat_messages, session_summaries
```

## Step 2 — Hyperdrive binding

```bash
cd worker
npx wrangler hyperdrive create ai-dm --connection-string="$DATABASE_URL"
# prints an id like 'a1b2c3d4...'
```

Open `worker/wrangler.toml` and uncomment + fill the Hyperdrive block:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<paste the id from above>"
```

## Step 3 — Worker secrets + deploy

```bash
cd worker

# A 32+ char random string. The agent will need to use this exact value.
npx wrangler secret put AGENT_SHARED_SECRET
# (paste the value when prompted)

# Optional but recommended: lock CORS to your Pages domain.
# You'll know the Pages URL after step 4; for now you can leave it default.
# npx wrangler secret put ALLOWED_ORIGINS
# (paste: https://ai-dm.pages.dev,http://localhost:5173)

# Deploy:
npx wrangler deploy
# prints: "Published ai-dm-worker (X.XX sec)"
# and:    "https://ai-dm-worker.YOUR-SUBDOMAIN.workers.dev"
```

Save that worker URL — the frontend needs it.

## Step 4 — Frontend env + Pages deploy

```bash
cd frontend
cat > .env.production <<EOF
VITE_API_BASE=https://ai-dm-worker.YOUR-SUBDOMAIN.workers.dev
VITE_WS_URL=wss://ai-dm-worker.YOUR-SUBDOMAIN.workers.dev
EOF

npm run build
npx wrangler pages deploy dist --project-name ai-dm
# prints: "Deployment complete!  https://ai-dm.pages.dev"
```

Now go back to the worker and pin the CORS allowlist to the Pages URL:

```bash
cd ../worker
echo "https://ai-dm.pages.dev,http://localhost:5173" | npx wrangler secret put ALLOWED_ORIGINS
```

## Step 5 — Bootstrap a DM token for your first campaign

A new campaign auto-issues a DM token. The lobby UI shows it. Alternative: hit the bootstrap endpoint to mint one for an existing campaign.

```bash
# Replace IDs and tokens as needed. AGENT_SHARED_SECRET is the secret you set in step 3.
curl -X POST 'https://ai-dm-worker.YOUR-SUBDOMAIN.workers.dev/api/campaigns/CAMPAIGN_ID/bootstrap-dm' \
  -H 'content-type: application/json' \
  -H "x-agent-secret: $AGENT_SHARED_SECRET" \
  -d '{"displayName":"DM"}'
```

Open the Pages URL with `?c=<campaignId>&inv=<dmToken>` to enter the room.

## Step 6 — Run the agent on your home machine

The agent runs locally and connects out to your deployed worker. It uses your Claude Code subscription — no Anthropic API key needed.

```bash
cd /path/to/ai-dm

# point at the deployed worker (not localhost)
export WORKER_WS=wss://ai-dm-worker.YOUR-SUBDOMAIN.workers.dev
export AGENT_SHARED_SECRET=<the same secret as the worker's secret>
export CAMPAIGN_ID=<your campaign id>

npm run dev:agent
# prints: "[agent] connected as ai-dm; .md mirror -> ~/.ai-dm/campaigns/<id>.md"
```

Leave that terminal running during your session. When you close your laptop, the AI-DM goes silent; the codex and chat still work in the browser, but `@dm` won't be answered until the agent reconnects.

---

## Verifying it works end-to-end

1. Open `https://ai-dm.pages.dev?c=<campaignId>&inv=<dmToken>`. You should see the lobby auto-resolve and drop you into the room.
2. Header shows **PERSISTED** badge with "saved to: Postgres + DO storage" tooltip.
3. Type `@dm say hello in five words` in the DM channel. The deliberation block appears; an agent message lands a few seconds later.
4. Click the `📋 copy` button on the agent reply. Open Discord, paste — formatted message.
5. Switch to the **codex** tab. The campaign you built locally should be there.

If any of those don't work, check:
- The agent's terminal — does it say `[agent] connected as ai-dm`? If not, `WORKER_WS` is wrong.
- Browser console — any CORS errors? Update `ALLOWED_ORIGINS` to include your Pages URL.
- `wrangler tail` (in the worker dir) streams live logs from the deployed worker.

---

## Costs to watch

- **Cloudflare**: free tier covers ~100k Worker invocations/day and unlimited Pages requests. A weekly game won't come close.
- **Neon**: 0.5 GB storage and 100 compute hours/month free. Your codex is in MB at most; you'll never hit either limit.
- **Anthropic**: **$0** — the agent uses your Claude Code subscription via the SDK (the SDK shells out to the CLI which reads your `~/.claude/` auth). The only way to incur metered API charges is to set `ANTHROPIC_API_KEY` in the agent's env, which you don't need to do.

If your Claude Code subscription has session caps and you blow through them in a session, you'd see the agent fail with an auth error rather than a surprise bill.

---

## Updating

- **Worker changes**: `cd worker && npx wrangler deploy`
- **Frontend changes**: `cd frontend && npm run build && npx wrangler pages deploy dist --project-name ai-dm`
- **Agent changes**: just `Ctrl+C` and rerun on your machine. tsx-watch handles edits in dev.
- **Schema changes**: edit `worker/src/db/schema.ts`, then either run `psql -f` against Neon with a hand-written migration, or use `npx drizzle-kit generate` to produce one.
