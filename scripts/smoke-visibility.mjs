import { WebSocket } from "ws";

const CAMPAIGN = process.env.CAMPAIGN_ID ?? "fJJLZa1Bd6";
const DM_TOKEN = process.env.DM_TOKEN ?? "dm_IkOF5bUyfz";

function connect(token, label) {
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN}`);
  const state = { snapshot: null, events: [], errors: [], label };
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", campaignId: CAMPAIGN, displayName: label, role: "player", token })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "snapshot") state.snapshot = m;
    else if (m.type === "error") state.errors.push(m);
    else state.events.push(m);
  });
  return { ws, state };
}

function rest(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // 1. Create two player invites via DM API.
  const mkInvite = async (displayName) => {
    const r = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-invite-token": DM_TOKEN },
      body: JSON.stringify({ displayName, role: "player" }),
    });
    return (await r.json()).invite.token;
  };
  const playerAToken = await mkInvite("Player-A");
  const playerBToken = await mkInvite("Player-B");
  console.log("created tokens:", playerAToken, playerBToken);

  // 2. Connect DM, player A, player B in parallel and wait for snapshots.
  const dm = connect(DM_TOKEN, "DM");
  const pa = connect(playerAToken, "Player-A");
  const pb = connect(playerBToken, "Player-B");
  await rest(800);

  const dmCount = dm.state.snapshot?.codex?.length ?? 0;
  const paCount = pa.state.snapshot?.codex?.length ?? 0;
  const dmOnlyCount = dm.state.snapshot?.codex?.filter(e => e.visibility === "dm").length ?? 0;
  console.log(`DM sees ${dmCount} entries (${dmOnlyCount} dm-only)`);
  console.log(`Player-A sees ${paCount} entries`);
  const filterWorks = dmCount > paCount && dmOnlyCount > 0;
  console.log(`${filterWorks ? "✓" : "✗"} dm-only entries hidden from player`);
  if (filterWorks) {
    const leak = pa.state.snapshot.codex.some(e => e.visibility === "dm");
    console.log(`${!leak ? "✓" : "✗"} player snapshot has zero dm-visibility entries`);
  }

  // 3. Pick a dm-visibility entry, flip to public, both players should see codex.upsert. Then flip back to dm — Player-A should get codex.hide.
  const dmOnly = dm.state.snapshot.codex.find(e => e.visibility === "dm");
  if (dmOnly) {
    console.log(`\nflipping ${dmOnly.id} (${dmOnly.title}) dm→public →dm to test codex.hide`);
    pa.state.events.length = 0;
    pb.state.events.length = 0;
    dm.ws.send(JSON.stringify({ type: "codex.upsert", entry: { ...dmOnly, visibility: "public" } }));
    await rest(300);
    const paGotUpsert = pa.state.events.find(e => e.type === "codex.upsert" && e.entry.id === dmOnly.id);
    console.log(`${paGotUpsert ? "✓" : "✗"} Player-A got codex.upsert on dm→public`);

    dm.ws.send(JSON.stringify({ type: "codex.upsert", entry: { ...dmOnly, visibility: "dm" } }));
    await rest(300);
    const paGotHide = pa.state.events.find(e => e.type === "codex.hide" && e.id === dmOnly.id);
    console.log(`${paGotHide ? "✓" : "✗"} Player-A got codex.hide on public→dm`);
  } else {
    console.log("(no dm-only entry to test with)");
  }

  // 4. Whisper from DM to Player-A: should reach DM + Player-A, NOT Player-B.
  console.log("\ntesting whisper DM → Player-A");
  pa.state.events.length = 0;
  pb.state.events.length = 0;
  dm.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "psst, treasure is behind the curtain", recipientId: playerAToken }));
  await rest(400);
  const paGotWhisper = pa.state.events.find(e => e.type === "chat" && e.message.text.includes("treasure"));
  const pbGotWhisper = pb.state.events.find(e => e.type === "chat" && e.message.text.includes("treasure"));
  console.log(`${paGotWhisper ? "✓" : "✗"} Player-A received whisper`);
  console.log(`${!pbGotWhisper ? "✓" : "✗"} Player-B did NOT receive whisper`);

  // 5. Player tries to whisper — should NOT be honored (server clears recipientId).
  console.log("\ntesting player cannot whisper");
  pa.state.events.length = 0;
  pb.state.events.length = 0;
  dm.state.events.length = 0;
  pa.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "secret player message", recipientId: playerBToken }));
  await rest(400);
  const pbSawIt = pb.state.events.find(e => e.type === "chat" && e.message.text.includes("secret player"));
  console.log(`${pbSawIt && !pbSawIt.message.recipientId ? "✓" : "✗"} player whisper was downgraded to public broadcast (Player-B saw it as public)`);

  // Cleanup
  for (const t of [playerAToken, playerBToken]) {
    await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites/${t}/revoke`, {
      method: "POST", headers: { "x-invite-token": DM_TOKEN },
    });
  }
  dm.ws.close(); pa.ws.close(); pb.ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
