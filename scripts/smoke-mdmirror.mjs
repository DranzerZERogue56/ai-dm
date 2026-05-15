import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? "UrLgmm9mV2";
const MD_PATH = process.env.MD_PATH ?? join(homedir(), ".ai-dm", "campaigns", `${CAMPAIGN_ID}.md`);

const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN_ID}`);

let upserts = 0;
ws.on("open", () => {
  console.log("[smoke] connected");
  ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN_ID, displayName: "smoke", role: "player" }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat",
      channel: "dm",
      text: "Set the scene: a smuggler captain named Yelva Stormcrow runs the Tide Crow tavern in the port-city of Brackmoor. Note all three (captain, tavern, city) in the codex."
    }));
  }, 400);
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "codex.upsert") {
    upserts++;
    console.log(`[upsert] [${m.entry.kind}] ${m.entry.title}`);
  } else if (m.type === "dm.status" && m.state === "idle") {
    setTimeout(async () => {
      try {
        const md = await readFile(MD_PATH, "utf8");
        console.log(`\n[smoke] .md path: ${MD_PATH}`);
        console.log(`[smoke] .md size: ${md.length} chars`);
        console.log(`[smoke] .md first lines:\n${md.split("\n").slice(0, 8).join("\n")}`);
        console.log(`[smoke] upserts seen: ${upserts}`);
        ws.close();
        process.exit(upserts > 0 && md.includes("# Campaign") ? 0 : 1);
      } catch (e) {
        console.error("[smoke] failed to read .md:", e.message);
        process.exit(1);
      }
    }, 1200);
  }
});

setTimeout(() => { console.log("[smoke] timeout"); process.exit(1); }, 120000);
