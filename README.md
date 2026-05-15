# AI-DM // Campaign Terminal

Terminal-aesthetic web app for solo DMs to **build a D&D 5e campaign** with Claude as the co-author, then run sessions in Discord by copy-pasting between the app and the chat. The Campaign Codex (NPCs, factions, lore, locations, quests, timelines, sections, links, tags) is the persistent brain.

The AI doesn't run live play — it helps you generate scenes, voice NPCs, narrate consequences, and audit the codex for hallucinations. The output is text you paste into Discord; player replies come back the same way.

## Stack

```
ai-dm/
  frontend/       Vite + React, CRT/green-phosphor UI, WebSocket client
  worker/         Cloudflare Worker + Durable Object (single CampaignRoom WS hub)
  ai-dm-agent/    Node service running the Claude Agent SDK
  shared/         Cross-package TS types
```

- **Frontend** (Cloudflare Pages) is just the codex editor + DM chat with copy-to-Discord
- **Worker + Durable Object** (Cloudflare Workers + Hyperdrive) holds room state and rebroadcasts events
- **Agent** runs on your home machine and uses your existing Claude Code `/login` subscription — no Anthropic API key, no per-token charges
- **Postgres** (Neon) is the canonical store; codex, chat, and invites all write through

## Local dev

```bash
npm install

# 1. Worker (port 8787)
npm run dev:worker

# 2. Frontend (port 5173, proxies /api + /ws to the worker)
npm run dev:frontend

# 3. AI-DM agent — uses your existing Claude Code login, no API key required.
#    Run `claude /login` once before this if you haven't.
CAMPAIGN_ID=<code> npm run dev:agent
```

Optional model override (defaults shown):

```
DM_MODEL=claude-sonnet-4-6
AUDIT_MODEL=claude-sonnet-4-6
```

## Workflow

1. Open the app, create a campaign — you get a DM invite token + magic link
2. Worldbuild: chat with the AI (with `@dm` or the 🤖 toggle), watch it commit NPCs / factions / lore to the codex with proper tags + cross-links
3. Edit anything by hand: the **Codex** tab is a full editor with kind tabs, sections, links, diffs, audit & merge tools
4. Run a session: type narration to the AI, click 📋 on its reply to copy a Discord-formatted block, paste into your party's chat
5. When players reply in Discord, click 📥 to switch the input to paste mode, dump their messages, send

## Persistence

- **DO storage** (always-on) — `.wrangler/state/` in dev, automatic in prod
- **Postgres** (optional in dev, required in prod) — write-through for codex, chat, invites
- **`.md` mirror** — agent writes `~/.ai-dm/campaigns/<id>.md` on every codex change so you have a human-readable archive

## Persistence schema

`worker/drizzle/0000_init.sql` is the canonical schema. Run it against your Postgres before first deploy.

## Deploy

See [DEPLOY.md](./DEPLOY.md) for the full step-by-step:

- Cloudflare Pages + Workers + Hyperdrive
- Neon Postgres (free tier is enough)
- Agent stays on your home machine
- ~$0/month if you already have a Claude Code subscription

## Notable agent tools

The agent's MCP server exposes these tools to the AI-DM, scoped to the current campaign:

- `codex_upsert` — create/update an entry with title, body, sections, tags, links
- `codex_link` — add a typed edge (`lives_in`, `member_of`, `enemy_of`, …) between two entries
- `codex_merge` — fold N duplicate entries into one and rewrite incoming links
- `codex_get` / `codex_search` / `codex_delete` — look things up + remove
- `combat_update` / `mode_set` — leftover from earlier play tooling; rarely used now

The audit pass (`audit codex` button) runs a separate Sonnet turn with the full chat history + every codex entry visible, instructing the model to compare what the chat actually established against what the codex claims — strips speculation, merges duplicates, adds missing links.
