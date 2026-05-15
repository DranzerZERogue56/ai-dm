import { WebSocket } from "ws";

const CAMPAIGN = process.env.CAMPAIGN_ID ?? "fJJLZa1Bd6";
const DM_TOKEN = process.env.DM_TOKEN ?? "dm_IkOF5bUyfz";

function connect(token, label) {
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN}`);
  const s = { snapshot: null, events: [], label };
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: label, role: "player", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "snapshot") s.snapshot = m;
    else s.events.push(m);
  });
  return { ws, state: s };
}
const rest = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Create a player invite
  const r = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-invite-token": DM_TOKEN },
    body: JSON.stringify({ displayName: "TestPlayer", role: "player" }),
  });
  const PLAYER_TOKEN = (await r.json()).invite.token;

  const dm = connect(DM_TOKEN, "DM");
  const pl = connect(PLAYER_TOKEN, "Player");
  await rest(800);

  // 1. Plain DM message — agent should NOT respond (no dm.status thinking).
  console.log("\n=== 1. Plain chat (no @dm, no invokeAi) should not trigger AI ===");
  const before1 = pl.state.events.length;
  pl.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "hello world" }));
  await rest(3000);
  const after1 = pl.state.events.slice(before1);
  const thinking1 = after1.find(e => e.type === "dm.status" && e.state === "thinking");
  console.log(`${!thinking1 ? "✓" : "✗"} no AI response on plain chat`);

  // 2. @dm prefix — AI should respond.
  console.log("\n=== 2. @dm prefix invokes AI ===");
  const before2 = pl.state.events.length;
  pl.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "@dm just say 'ok'" }));
  // Wait up to ~30s for the agent to do its thing
  for (let i = 0; i < 30; i++) {
    if (pl.state.events.slice(before2).find(e => e.type === "dm.status" && e.state === "idle")) break;
    await rest(1000);
  }
  const after2 = pl.state.events.slice(before2);
  const thinking2 = after2.find(e => e.type === "dm.status" && e.state === "thinking");
  console.log(`${thinking2 ? "✓" : "✗"} @dm invocation triggered AI thinking`);

  // 3. Pause AI, then @dm should be ignored.
  console.log("\n=== 3. ai.pause blocks even @dm ===");
  dm.ws.send(JSON.stringify({ type: "ai.pause", paused: true }));
  await rest(300);
  const before3 = pl.state.events.length;
  pl.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "@dm say 'paused test'" }));
  await rest(4000);
  const after3 = pl.state.events.slice(before3);
  const thinking3 = after3.find(e => e.type === "dm.status" && e.state === "thinking");
  console.log(`${!thinking3 ? "✓" : "✗"} paused AI ignores @dm`);
  dm.ws.send(JSON.stringify({ type: "ai.pause", paused: false }));
  await rest(300);

  // 4. Player tries to update combat — server rejects with error.
  console.log("\n=== 4. Player combat.update rejected ===");
  const before4 = pl.state.events.length;
  pl.ws.send(JSON.stringify({ type: "combat.update", state: { active: true, round: 99, turnIndex: 0, combatants: [] } }));
  await rest(400);
  const err = pl.state.events.slice(before4).find(e => e.type === "error" && /DM-only/.test(e.message));
  console.log(`${err ? "✓" : "✗"} player got 'DM-only' error`);

  // 5. roll.request — whisper to player only.
  console.log("\n=== 5. roll.request whispered to target only ===");
  // Need a second player to confirm whisper isolation.
  const r2 = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-invite-token": DM_TOKEN },
    body: JSON.stringify({ displayName: "OtherPlayer", role: "player" }),
  });
  const OTHER_TOKEN = (await r2.json()).invite.token;
  const pl2 = connect(OTHER_TOKEN, "Other");
  await rest(500);
  const before5 = pl.state.events.length;
  const before5b = pl2.state.events.length;
  dm.ws.send(JSON.stringify({ type: "roll.request", targetId: PLAYER_TOKEN, label: "Perception", dice: "1d20", dc: 14, whisper: true }));
  await rest(400);
  const plGot = pl.state.events.slice(before5).find(e => e.type === "roll.request");
  const otherGot = pl2.state.events.slice(before5b).find(e => e.type === "roll.request");
  console.log(`${plGot ? "✓" : "✗"} target player got whispered roll.request`);
  console.log(`${!otherGot ? "✓" : "✗"} other player did NOT receive it`);

  // 6. speak-as-NPC: DM sends chat with speakAsNpcId; player sees speakAsNpcName.
  console.log("\n=== 6. speak-as-NPC routed with NPC name ===");
  // Pick any NPC from the snapshot
  const npc = dm.state.snapshot.codex.find(e => e.kind === "npc");
  const before6 = pl.state.events.length;
  dm.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "well met, traveler", speakAsNpcId: npc.id }));
  await rest(400);
  const after6 = pl.state.events.slice(before6);
  const npcMsg = after6.find(e => e.type === "chat" && e.message.speakAsNpcId === npc.id);
  console.log(`${npcMsg ? "✓" : "✗"} NPC message received with speakAsNpcId=${npcMsg?.message?.speakAsNpcName ?? "?"}`);

  // 7. Player attempts speak-as-NPC: server strips it.
  console.log("\n=== 7. Player cannot speak-as-NPC ===");
  const before7 = pl2.state.events.length;
  pl.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "I am the NPC now", speakAsNpcId: npc.id }));
  await rest(400);
  const msg7 = pl2.state.events.slice(before7).find(e => e.type === "chat" && e.message.text.includes("NPC now"));
  console.log(`${msg7 && !msg7.message.speakAsNpcId ? "✓" : "✗"} player speakAsNpcId stripped server-side`);

  // Cleanup
  for (const t of [PLAYER_TOKEN, OTHER_TOKEN]) {
    await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites/${t}/revoke`, {
      method: "POST", headers: { "x-invite-token": DM_TOKEN },
    });
  }
  dm.ws.close(); pl.ws.close(); pl2.ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
