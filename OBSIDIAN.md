# Obsidian Vault Mirror

The agent can write the campaign codex into an [Obsidian](https://obsidian.md) vault as a one-way, real-time mirror. One `.md` file per entry, organized by kind, with `[[wikilinks]]` between related entries, YAML frontmatter, and inline tags.

## Setup (continuous mirror)

Point the agent at your vault by setting `OBSIDIAN_VAULT` when you start it:

```bash
OBSIDIAN_VAULT=~/Documents/MyVault CAMPAIGN_ID=fJJLZa1Bd6 npm run dev:agent
```

The agent connects, pulls the snapshot, and starts writing to `<vault>/AI-DM/<campaignId>/`. Every codex change — yours via the app, the AI's via tool calls — re-syncs within ~600ms.

Open Obsidian, point it at your vault, and the campaign is just a subfolder. Wikilinks render, the graph view works, Dataview queries against frontmatter work.

## What gets written

```
<vault>/AI-DM/<campaignId>/
  _Index.md              ← grouped directory of every entry
  .ai-dm-manifest.json   ← internal; tracks files to clean up on rename
  Npcs/
    Pax al Talmanus — The Careful Cyclops.md
    ...
  Factions/
    The 4th Pier — The Pirates.md
    ...
  Lore/
  Locations/
  Towns/
  Quests/
  Items/
  Timeline/
  Calendar/
  Maps/
  Session Notes/
  Journals/
  House Rules/
  Player Characters/
```

Each entry file has:

```markdown
---
id: yk8uFWRXo1
kind: npc
campaign: fJJLZa1Bd6
visibility: public
updated: 2026-05-14T21:21:59Z
tags: [cyclops, deceased, 4th-pier, martyr, pax]
aliases:
  - "Pax al Talmanus — The Careful Cyclops"
  - yk8uFWRXo1
ai-dm-mirror: true
---

# Pax al Talmanus — The Careful Cyclops (Martyred)

> [!info] Npc · visibility: `public`
> _Source of truth: the AI-DM codex. Edits here will be overwritten on the next sync._

A Cyclops guard stationed on the Isle of the Owls...

## Appearance
...

## Backstory
...

## Links
- **stationed_at** → [[The Isle of the Owls|The Isle of the Owls — Starting Location]]
- **friend_of** → [[Neril — Retired Hell-Diver|Neril — Retired Hell-Diver, 4th Pier Armory (The Father)]]

#cyclops #deceased #4th-pier #martyr #pax
```

## One-shot export (no agent required)

If you just want a snapshot dump and not continuous sync:

```bash
npx tsx scripts/export-obsidian.ts \
  --vault ~/Documents/MyVault \
  --campaign fJJLZa1Bd6 \
  --token   dm_xxxxxxxxxx
```

You'll need a DM invite token for the campaign (get one from the `co-DMs` button in the app, or mint one via the API). Works against either your local worker or the deployed one — pass `--worker wss://ai-dm-worker.YOUR.workers.dev` for the latter.

## What's *not* mirrored

- **Chat history** — only codex entries. Chat lives in DO storage + Postgres.
- **Combat / dice state** — those left the app in the slim-down.
- **DM-only entries to non-DM viewers** — but for the mirror it doesn't matter; you (the DM) see everything anyway.

## Caveats

- **Vault is read-only.** Edits you make in Obsidian get overwritten on the next sync. Edit in the app instead.
- **The campaign subfolder gets rewritten in-place.** Don't drop your own custom `.md` files inside `<vault>/AI-DM/<campaignId>/` — they won't survive. Keep custom notes anywhere else in the vault.
- **Filename sanitization**: characters that break filesystems (`<>:"/\\|?*` and control chars) are replaced with underscores. Display titles preserve the original via the aliased wikilink (`[[sanitized|original]]`).
- **Renamed entries** are handled cleanly: the manifest tracks last sync's file paths and removes orphans on the next write.

## Workflow with Claude Code

You can run Claude Code in the same vault and it can read/reference your codex notes directly. Two patterns:

1. **Run Claude Code at the vault root** — it sees the AI-DM folder alongside your other notes. Ask it questions like "summarize the conflict between Carr and Lilith based on these files."
2. **Run Claude Code in the project** — Code sees the same source codex live (via the agent). Use it to write code; use Obsidian for browsing.

The agent uses your Claude Code login auth and produces the codex; Claude Code reads the resulting vault. Neither costs anything beyond your existing subscription.
