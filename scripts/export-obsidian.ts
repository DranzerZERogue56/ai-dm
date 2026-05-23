#!/usr/bin/env tsx
// One-shot Obsidian vault export. Connects via WS as a DM, pulls the snapshot,
// renders the full vault structure into <vault>/AI-DM/<campaignId>/.
//
// usage:
//   npx tsx scripts/export-obsidian.ts \
//     --vault ~/Documents/MyVault \
//     --campaign fJJLZa1Bd6 \
//     --token   dm_xxxxx \
//     [--worker wss://ai-dm-worker.YOUR.workers.dev]
//
// or via env vars:
//   OBSIDIAN_VAULT=~/Documents/MyVault CAMPAIGN_ID=... DM_TOKEN=... npx tsx scripts/export-obsidian.ts
import { WebSocket } from "ws";
import { writeVault } from "../ai-dm-agent/src/obsidian-vault";
import { homedir } from "node:os";
import { resolve } from "node:path";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
function expand(p?: string): string | undefined {
  if (!p) return p;
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

const VAULT = expand(arg("vault", process.env.OBSIDIAN_VAULT)) ?? "";
const CAMPAIGN = arg("campaign", process.env.CAMPAIGN_ID);
const TOKEN = arg("token", process.env.DM_TOKEN);
const WORKER = arg("worker", process.env.WORKER_WS ?? "ws://127.0.0.1:8787");

if (!VAULT || !CAMPAIGN || !TOKEN) {
  console.error("Required: --vault <path> --campaign <id> --token <dm_token>");
  console.error("Or set OBSIDIAN_VAULT, CAMPAIGN_ID, DM_TOKEN env vars.");
  process.exit(2);
}

const vaultAbs = resolve(VAULT);
console.log(`[obsidian-export] vault=${vaultAbs}`);
console.log(`[obsidian-export] campaign=${CAMPAIGN}`);
console.log(`[obsidian-export] worker=${WORKER}`);

const ws = new WebSocket(`${WORKER}/ws/${CAMPAIGN}`);
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: "obsidian-export", role: "dm", token: TOKEN })));
ws.on("message", async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") {
    try {
      await writeVault(vaultAbs, CAMPAIGN!, m.codex);
      console.log(`[obsidian-export] wrote ${m.codex.length} entries to ${vaultAbs}/AI-DM/${CAMPAIGN}/`);
    } catch (e) {
      console.error("[obsidian-export] failed:", e);
      process.exitCode = 1;
    }
    ws.close();
    process.exit(process.exitCode ?? 0);
  } else if (m.type === "error") {
    console.error("[obsidian-export] server error:", m.message);
    process.exit(1);
  }
});
ws.on("error", (e) => { console.error("[obsidian-export] ws error:", (e as Error).message); process.exit(1); });
setTimeout(() => { console.error("[obsidian-export] timeout"); process.exit(1); }, 15000);
