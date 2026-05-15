import { WebSocket } from "ws";
const ws = new WebSocket("ws://127.0.0.1:8787/ws/fJJLZa1Bd6");
ws.on("open", () => ws.send(JSON.stringify({ type:"hello", campaignId:"fJJLZa1Bd6", displayName:"DM", role:"dm", token:"dm_IkOF5bUyfz" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") {
    ws.send(JSON.stringify({ type:"codex.delete", id:"lqdypBs3rW" }));
    setTimeout(() => process.exit(0), 500);
  }
});
setTimeout(() => process.exit(0), 3000);
