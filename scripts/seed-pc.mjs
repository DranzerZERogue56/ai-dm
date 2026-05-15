import { WebSocket } from "ws";
const CAMPAIGN = "fJJLZa1Bd6";
const DM_TOKEN = "dm_IkOF5bUyfz";
const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN}`);
ws.on("open", () => {
  console.log("opened");
  ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: "DM", role: "dm", token: DM_TOKEN }));
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") {
    console.log("snapshot ok, sending upsert");
    ws.send(JSON.stringify({
      type: "codex.upsert",
      entry: {
        kind: "pc",
        title: "Sample PC — Pax's Hell-Diver",
        body: "A 4th-Pier Hell-Diver. The Hell-Diver Pax died for.",
        sections: [
          { title: "Backstory", body: "Son of Neril. Inherited the drill. Watched Pax die in his place." },
        ],
        tags: ["pc","4th-pier","pirates","hell-diver"],
        visibility: "public",
        data: {
          sheet: {
            level: 1, race: "Human", classes: [{ name: "Fighter", level: 1 }],
            abilities: { str: 16, dex: 13, con: 14, int: 10, wis: 12, cha: 11 },
            ac: 16, hp: { current: 12, max: 12 }, speed: 30, proficiencyBonus: 2,
            savingThrows: { str: { proficient: true }, con: { proficient: true } },
            skills: { athletics: { proficient: true }, perception: { proficient: true } },
            inventory: [{ id: "drill", name: "Neril's Magic Drill", qty: 1, equipped: true }],
            gold: 5, features: [{ name: "Second Wind", source: "Fighter" }],
          },
        },
      },
    }));
  }
  if (m.type === "codex.upsert") {
    console.log("upsert acked:", m.entry.id, m.entry.title);
    ws.close();
    process.exit(0);
  }
  if (m.type === "error") {
    console.error("error:", m.message);
    process.exit(1);
  }
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
