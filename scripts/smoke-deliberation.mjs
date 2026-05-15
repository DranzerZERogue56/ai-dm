import { WebSocket } from "ws";

const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? "UrLgmm9mV2";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN_ID}`);

let statusEvents = 0;
let partialEvents = 0;
let lastThinkingLen = 0;
let lastTextLen = 0;
let chatReplies = 0;

ws.on("open", () => {
  console.log("[smoke] connected");
  ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN_ID, displayName: "smoke", role: "player" }));
  setTimeout(() => {
    console.log("[smoke] sending DM message");
    ws.send(JSON.stringify({
      type: "chat",
      channel: "dm",
      text: "Think out loud: what makes a frozen archipelago feel desperate vs hopeful? Then ask the players one question.",
    }));
  }, 500);
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "dm.status") {
    statusEvents++;
    console.log(`[dm.status] -> ${m.state}`);
    if (m.state === "idle" && statusEvents >= 2) {
      console.log(`\n[smoke] DONE. status events=${statusEvents}, partial events=${partialEvents}, chat replies=${chatReplies}, final thinking chars=${lastThinkingLen}, final text chars=${lastTextLen}`);
      ws.close();
      setTimeout(() => process.exit(0), 200);
    }
  } else if (m.type === "dm.partial") {
    partialEvents++;
    if (m.partial.thinking) lastThinkingLen = m.partial.thinking.length;
    if (m.partial.text) lastTextLen = m.partial.text.length;
    if (m.partial.toolUse) console.log(`[dm.partial] tool: ${m.partial.toolUse.name} ${m.partial.toolUse.preview ?? ""}`);
    if (partialEvents % 10 === 0) console.log(`[dm.partial] #${partialEvents} thinking=${lastThinkingLen}c text=${lastTextLen}c`);
  } else if (m.type === "chat") {
    if (m.message.channel === "dm" && m.message.authorRole === "dm") {
      chatReplies++;
      console.log(`[chat:dm] AI-DM reply (${m.message.text.length} chars)`);
    }
  } else if (m.type === "codex.upsert") {
    console.log(`[codex.upsert] [${m.entry.kind}] ${m.entry.title}`);
  }
});

setTimeout(() => { console.log("[smoke] timeout"); ws.close(); process.exit(1); }, 90000);
