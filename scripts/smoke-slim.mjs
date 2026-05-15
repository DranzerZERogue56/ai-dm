// Slim app smoke: verify the DM-only workflow.
// - DM connects with token, gets snapshot
// - @dm message triggers an agent reply
// - speak-as-NPC message renders with NPC name (resolved server-side)
// - codex.upsert from DM works
// - dice / combat / roll.request paths can still be sent but we don't use them
import { WebSocket } from "ws";

const CAMPAIGN = "fJJLZa1Bd6";
const DM_TOKEN = "dm_IkOF5bUyfz";
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, l) => { console.log(`  ${c ? "✓" : "✗"} ${l}`); if (!c) failed++; };

const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN}`);
const s = { snapshot: null, events: [] };
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: "DM", role: "dm", token: DM_TOKEN })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") s.snapshot = m;
  else s.events.push(m);
});

await rest(1200);

console.log("=== Slim DM workflow ===");
ok(!!s.snapshot, "DM got a snapshot");
ok(s.snapshot?.codex.length > 0, `codex has ${s.snapshot?.codex.length} entries`);
ok(s.snapshot?.aiPaused === false, "AI starts unpaused");

console.log("\n=== @dm triggers agent reply ===");
const before = s.events.length;
ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "@dm say 'slim test ok' in exactly four words." }));
for (let i = 0; i < 45; i++) {
  if (s.events.slice(before).find((e) => e.type === "dm.status" && e.state === "idle")) break;
  await rest(1000);
}
const thinking = s.events.slice(before).find((e) => e.type === "dm.status" && e.state === "thinking");
const agentReply = s.events.slice(before).find((e) => e.type === "chat" && e.message.authorRole === "agent");
ok(!!thinking, "agent showed dm.status thinking");
ok(!!agentReply, `agent replied (${agentReply?.message?.text?.slice(0, 80)}…)`);

console.log("\n=== Speak-as-NPC resolves to NPC name ===");
const npc = s.snapshot.codex.find((e) => e.kind === "npc");
const before2 = s.events.length;
ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "I greet you", speakAsNpcId: npc.id }));
await rest(500);
const npcMsg = s.events.slice(before2).find((e) => e.type === "chat" && e.message.speakAsNpcId === npc.id);
ok(!!npcMsg, "speak-as message broadcast");
ok(npcMsg?.message?.speakAsNpcName === npc.title, `speakAsNpcName resolved to "${npcMsg?.message?.speakAsNpcName}"`);

console.log("\n=== Codex upsert from DM works ===");
const before3 = s.events.length;
ws.send(JSON.stringify({
  type: "codex.upsert",
  entry: { kind: "lore", title: "Slim test entry", body: "Created by the slim smoke test.", visibility: "dm", tags: ["test"] },
}));
await rest(500);
const upsert = s.events.slice(before3).find((e) => e.type === "codex.upsert" && e.entry.title === "Slim test entry");
ok(!!upsert, "DM upsert succeeded");
if (upsert) {
  // Cleanup
  ws.send(JSON.stringify({ type: "codex.delete", id: upsert.entry.id }));
  await rest(200);
}

ws.close();
console.log(`\n${failed === 0 ? "ALL PASSED" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
