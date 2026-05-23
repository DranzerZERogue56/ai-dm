// End-to-end smoke: edit a vault file, then trigger vault.scan via WS,
// verify diff comes back, send vault.apply, verify codex.upsert lands,
// and confirm the new content is in the snapshot.
import { WebSocket } from "ws";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CAMPAIGN = "fJJLZa1Bd6";
const DM_TOKEN = "dm_IkOF5bUyfz";
const VAULT = "/home/benjamin/D&D";

let failed = 0;
const ok = (c, l) => { console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${l}`); if (!c) failed++; };
const rest = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN}`);
const events = [];
let snapshot = null;
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: "vault-smoke", role: "dm", token: DM_TOKEN })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") snapshot = m;
  events.push(m);
});

await rest(1500);

console.log("=== Setup ===");
ok(!!snapshot, "got snapshot");

// Pick a victim entry — first NPC.
const victim = snapshot.codex.find((e) => e.kind === "npc");
ok(!!victim, `picked victim: ${victim?.title}`);

// Find its file in the vault and modify it.
const root = join(VAULT, "AI-DM", CAMPAIGN);
const candidatePaths = [
  join(root, "Npcs", `${victim.title}.md`),
];
// Try a sanitized variant if the original has special chars.
const sanitized = victim.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
candidatePaths.push(join(root, "Npcs", `${sanitized}.md`));

let target = null;
for (const p of candidatePaths) {
  try { await readFile(p, "utf8"); target = p; break; } catch {}
}
ok(!!target, `found vault file: ${target}`);

const original = await readFile(target, "utf8");
console.log(`    original file: ${original.length} chars, starts: ${JSON.stringify(original.slice(0, 80))}`);
if (original.length < 100) {
  console.error("    ⚠ refusing to run: target file is too small, likely from a bad prior run. Re-run scripts/export-obsidian.ts first.");
  process.exit(2);
}
const SENTINEL = `**SMOKE-TEST-SENTINEL-${Date.now()}**: edited by smoke-vault-gate.mjs\n`;
// Insert sentinel into the BODY (between H1 and first H2), where a user would actually edit.
let edited;
if (original.includes(SENTINEL)) edited = original;
else {
  const h2Idx = original.search(/\n##\s/);
  if (h2Idx < 0) edited = original.replace(/(^#\s.+\n)/, `$1\n${SENTINEL}\n`);
  else edited = original.slice(0, h2Idx) + `\n${SENTINEL}` + original.slice(h2Idx);
}
await writeFile(target, edited, "utf8");
ok(true, `wrote sentinel into body of ${target}`);

// Wait a tick for filesystem.
await rest(300);

// Send vault.scan
console.log("\n=== Scan ===");
const reqId = "smoke-" + Date.now();
ws.send(JSON.stringify({ type: "vault.scan", requestId: reqId }));
// Wait for vault.diff
for (let i = 0; i < 20; i++) {
  if (events.find((e) => e.type === "vault.diff" && e.requestId === reqId)) break;
  await rest(200);
}
const diff = events.find((e) => e.type === "vault.diff" && e.requestId === reqId);
ok(!!diff, "received vault.diff");
ok(diff?.changes?.length >= 1, `${diff?.changes?.length ?? 0} change(s) detected`);
const change = diff?.changes?.find((c) => c.entryId === victim.id);
ok(!!change, "victim entry is in the diff");
ok(change?.fields?.includes("body"), `body marked as changed (fields: ${change?.fields?.join(",")})`);

// Apply
console.log("\n=== Apply ===");
ws.send(JSON.stringify({ type: "vault.apply", requestId: reqId, changes: [change] }));
// Wait for the upsert to come back
for (let i = 0; i < 20; i++) {
  if (events.find((e) => e.type === "codex.upsert" && e.entry.id === victim.id && e.entry.body.includes("SMOKE-TEST-SENTINEL"))) break;
  await rest(200);
}
const applied = events.find((e) => e.type === "codex.upsert" && e.entry.id === victim.id && e.entry.body.includes("SMOKE-TEST-SENTINEL"));
ok(!!applied, "codex.upsert with sentinel body landed");

// Cleanup: restore the codex entry to its original body so the smoke is idempotent.
console.log("\n=== Cleanup ===");
ws.send(JSON.stringify({ type: "codex.upsert", entry: { ...victim } }));
await rest(400);
// And revert the file on disk to canonical.
await writeFile(target, original, "utf8");
ok(true, "rolled back codex + file to pre-smoke state");

ws.close();
console.log(`\n${failed === 0 ? "ALL PASSED" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
