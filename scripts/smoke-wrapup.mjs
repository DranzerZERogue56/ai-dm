import { WebSocket } from "ws";

const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? "UrLgmm9mV2";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN_ID}`);

let gotSessionNote = false;
let chatReplies = 0;
let statusTransitions = 0;

ws.on("open", () => {
  console.log("[smoke] connected");
  ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN_ID, displayName: "smoke", role: "player" }));
  // Seed a brief recent chat so the summary has something to chew on.
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "We just finished fighting two frost wraiths in the bell tower of Old Kalvik. Bram took 14 damage. We found a sealed letter on the priest's body." }));
  }, 400);
  setTimeout(() => {
    console.log("[smoke] requesting wrapup");
    ws.send(JSON.stringify({ type: "session.wrapup", reason: "smoke-test" }));
  }, 12000);
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "dm.status") {
    statusTransitions++;
    console.log(`[dm.status] ${m.state}${m.detail ? ` (${m.detail})` : ""}`);
  } else if (m.type === "codex.upsert") {
    console.log(`[codex.upsert] [${m.entry.kind}] ${m.entry.title}`);
    if (m.entry.kind === "session_note") gotSessionNote = true;
  } else if (m.type === "chat" && m.message.authorRole === "dm") {
    chatReplies++;
    console.log(`[chat:dm] AI-DM (${m.message.text.length} chars): ${m.message.text.slice(0, 120)}...`);
  } else if (m.type === "session.wrapup") {
    console.log(`[session.wrapup] reason=${m.reason}`);
  }
});

setTimeout(() => {
  console.log(`\n[smoke] DONE. session_note created=${gotSessionNote}, chat replies=${chatReplies}, status transitions=${statusTransitions}`);
  ws.close();
  process.exit(gotSessionNote ? 0 : 1);
}, 90000);
