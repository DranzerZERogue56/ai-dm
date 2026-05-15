import { WebSocket } from "ws";
const id = process.env.CAMPAIGN_ID ?? "UrLgmm9mV2";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${id}`);
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: id, displayName: "check", role: "player" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") {
    console.log(`mode=${m.mode}  codex=${m.codex.length}`);
    for (const e of m.codex) console.log(`  [${e.kind}] ${e.title}`);
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 5000);
