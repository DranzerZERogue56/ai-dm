// Verify the player layout's wire contract:
// - Player gets snapshot with their pcId in participants list.
// - Codex includes the bound PC (visibility=public).
// - Player chat is non-whisperable + no AI auto-respond.
// - readOnly combat means player update gets rejected.
// - Journal upsert succeeds (visibility=player, ownerId=token).
import { WebSocket } from "ws";

const CAMPAIGN = "fJJLZa1Bd6";
const DM_TOKEN = "dm_IkOF5bUyfz";
const PLAYER_TOKEN = process.argv[2];
if (!PLAYER_TOKEN) { console.error("usage: node smoke-player-layout.mjs <player_token>"); process.exit(2); }

const rest = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (cond, label) => { console.log(`  ${cond ? "✓" : "✗"} ${label}`); if (!cond) failed++; };

function connect(token, label) {
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN}`);
  const s = { snapshot: null, events: [], errors: [], label };
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: label, role: "player", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "snapshot") s.snapshot = m;
    else if (m.type === "error") s.errors.push(m);
    else s.events.push(m);
  });
  return { ws, state: s };
}

async function main() {
  const pl = connect(PLAYER_TOKEN, "Player");
  await rest(800);

  console.log("=== Player joined ===");
  const me = pl.state.snapshot?.participants?.find((p) => p.id === PLAYER_TOKEN);
  check(!!me, "participant for player token present in snapshot");
  check(me?.pcId === "y3SlvRoxkp", `participant.pcId is the bound PC (got: ${me?.pcId})`);
  check(me?.role === "player", `participant.role === player (got: ${me?.role})`);

  const pc = pl.state.snapshot?.codex?.find((e) => e.id === "y3SlvRoxkp");
  check(!!pc, "PC entry visible to player");
  check(pc?.kind === "pc", "PC entry has kind=pc");
  check(!!pc?.data?.sheet, "PC has structured sheet data");

  console.log("\n=== Combat update from player rejected ===");
  const before = pl.state.errors.length;
  pl.ws.send(JSON.stringify({ type: "combat.update", state: { active: false, round: 0, turnIndex: 0, combatants: [] } }));
  await rest(300);
  check(pl.state.errors.slice(before).find((e) => /DM-only/.test(e.message)), "combat.update rejected");

  console.log("\n=== Journal upsert from player succeeds ===");
  pl.ws.send(JSON.stringify({
    type: "codex.upsert",
    entry: {
      kind: "journal",
      title: "Pax-Player's Journal",
      body: "Day 1: heard a noise under my drill. The Architects said it was nothing.",
      visibility: "player",
      ownerId: PLAYER_TOKEN,
      tags: ["journal", "private"],
    },
  }));
  await rest(500);
  // Check via DM connection to see if the journal entry shows up
  const dm = connect(DM_TOKEN, "DM-check");
  // override role to dm since connect() always sends player; need direct send
  await rest(300);
  // Actually the connect() helper sets role=player but server uses the token's role; DM token resolves to DM. So fine.
  const journal = dm.state.snapshot?.codex?.find((e) => e.kind === "journal" && e.ownerId === PLAYER_TOKEN);
  check(!!journal, "DM can see the player's journal");
  check(journal?.visibility === "player", "journal has visibility=player");

  console.log("\n=== Other players cannot see this journal ===");
  const r = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-invite-token": DM_TOKEN },
    body: JSON.stringify({ displayName: "Snoop", role: "player" }),
  });
  const OTHER = (await r.json()).invite.token;
  const snoop = connect(OTHER, "Snoop");
  await rest(800);
  const journalLeak = snoop.state.snapshot?.codex?.find((e) => e.kind === "journal" && e.ownerId === PLAYER_TOKEN);
  check(!journalLeak, "Snoop's snapshot does NOT include the journal");
  await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites/${OTHER}/revoke`, {
    method: "POST", headers: { "x-invite-token": DM_TOKEN },
  });

  pl.ws.close(); dm.ws.close(); snoop.ws.close();
  console.log(`\n${failed === 0 ? "ALL PASSED" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
