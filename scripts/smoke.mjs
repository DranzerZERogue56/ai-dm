import { WebSocket } from "ws";

const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? "nBS489ULvc";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN_ID}`);

ws.on("open", () => {
  console.log("[smoke] connected");
  ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN_ID, displayName: "smoke-player", role: "player" }));
  setTimeout(() => {
    console.log("[smoke] sending DM message");
    ws.send(JSON.stringify({
      type: "chat",
      channel: "dm",
      text: "Hi DM! Let's start worldbuilding. Our setting is a frozen archipelago where the sun hasn't risen in 400 years. Ask us our first question."
    }));
  }, 500);
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "chat") console.log(`[chat:${m.message.channel}] ${m.message.authorName}: ${m.message.text}`);
  else if (m.type === "codex.upsert") console.log(`[codex.upsert] [${m.entry.kind}] ${m.entry.title} -- ${m.entry.body.slice(0, 80)}...`);
  else if (m.type === "mode.set") console.log(`[mode.set] ${m.mode}`);
  else if (m.type === "combat.update") console.log(`[combat.update] active=${m.state.active} combatants=${m.state.combatants.length}`);
  else if (m.type === "snapshot") console.log(`[snapshot] mode=${m.mode} codex=${m.codex.length} participants=${m.participants.length}`);
});

setTimeout(() => { console.log("[smoke] timeout, closing"); ws.close(); process.exit(0); }, 60000);
