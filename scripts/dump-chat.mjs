import { WebSocket } from "ws";
import { writeFile } from "node:fs/promises";

const id = process.env.CAMPAIGN_ID ?? "fJJLZa1Bd6";
const TOKEN = process.env.DM_TOKEN ?? "dm_IkOF5bUyfz";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${id}`);
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: id, displayName: "dump", role: "dm", token: TOKEN })));
ws.on("message", async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") {
    await writeFile("/tmp/codex_chat.json", JSON.stringify(m.chat, null, 2));
    await writeFile("/tmp/codex_full.json", JSON.stringify(m.codex, null, 2));
    console.log(`chat=${m.chat.length} messages, codex=${m.codex.length} entries`);
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
