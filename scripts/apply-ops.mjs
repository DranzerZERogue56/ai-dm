// Apply a batch of codex operations (merge = upsert target + delete sources) via WS.
// Usage: CAMPAIGN_ID=fJJLZa1Bd6 node scripts/apply-ops.mjs /tmp/batch1_ops.json
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";

const file = process.argv[2];
const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? "fJJLZa1Bd6";
if (!file) { console.error("usage: node apply-ops.mjs <ops.json>"); process.exit(2); }

const ops = JSON.parse(await readFile(file, "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN_ID}`);

let ack = { upserts: 0, deletes: 0, expectedUpserts: 0, expectedDeletes: 0 };
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN_ID, displayName: "opus-editor", role: "dm" }));
  setTimeout(run, 400);
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "codex.upsert") ack.upserts++;
  if (m.type === "codex.delete") ack.deletes++;
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });

async function run() {
  for (const merge of ops.merges ?? []) {
    console.log(`\n=== MERGE → ${merge.entry.title} ===`);
    console.log(`  target=${merge.targetId}  sources=[${merge.sourceIds.join(", ")}]`);
    ack.expectedUpserts++;
    ws.send(JSON.stringify({ type: "codex.upsert", entry: merge.entry }));
    await sleep(120);
    for (const sid of merge.sourceIds) {
      ack.expectedDeletes++;
      ws.send(JSON.stringify({ type: "codex.delete", id: sid }));
      await sleep(60);
    }
  }
  for (const u of ops.upserts ?? []) {
    console.log(`=== UPSERT → ${u.title} (${u.id ?? "new"}) ===`);
    ack.expectedUpserts++;
    ws.send(JSON.stringify({ type: "codex.upsert", entry: u }));
    await sleep(120);
  }
  for (const d of ops.deletes ?? []) {
    ack.expectedDeletes++;
    ws.send(JSON.stringify({ type: "codex.delete", id: d }));
    await sleep(60);
  }
  // Wait for echo from DO so we know it processed all.
  await sleep(1500);
  console.log(`\nDONE. upserts ${ack.upserts}/${ack.expectedUpserts}, deletes ${ack.deletes}/${ack.expectedDeletes}`);
  ws.close();
  process.exit(ack.upserts >= ack.expectedUpserts && ack.deletes >= ack.expectedDeletes ? 0 : 1);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
setTimeout(() => { console.error("timeout"); process.exit(1); }, 60000);
