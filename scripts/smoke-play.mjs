// End-to-end "live play" smoke. Three real WS clients: DM + PlayerA + PlayerB.
// Verifies the human-facing flows that matter most during a session.
import { WebSocket } from "ws";

const CAMPAIGN = process.env.CAMPAIGN_ID ?? "fJJLZa1Bd6";
const DM_TOKEN = process.env.DM_TOKEN ?? "dm_IkOF5bUyfz";

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
  ws.on("close", () => { s.closed = true; });
  return { ws, state: s };
}
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
let failed = 0;
function check(cond, label) {
  console.log(`  ${cond ? PASS : FAIL} ${label}`);
  if (!cond) failed++;
}

async function mkInvite(displayName) {
  const r = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-invite-token": DM_TOKEN },
    body: JSON.stringify({ displayName, role: "player" }),
  });
  return (await r.json()).invite.token;
}

async function main() {
  console.log("\n=== Setting up: 3 clients (DM, PlayerA, PlayerB) ===");
  const pa_token = await mkInvite("Alice");
  const pb_token = await mkInvite("Bob");
  const dm = connect(DM_TOKEN, "DM");
  const a = connect(pa_token, "Alice");
  const b = connect(pb_token, "Bob");
  await rest(1000);
  check(dm.state.snapshot && a.state.snapshot && b.state.snapshot, "all three got snapshots");

  // Test 1: WHISPER — the most important DM↔Player feature.
  console.log("\n=== TEST 1: DM whisper to Alice → invisible to Bob ===");
  const beforeA = a.state.events.length;
  const beforeB = b.state.events.length;
  dm.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "The key is under the loose floorboard.", recipientId: pa_token }));
  await rest(400);
  const aGot = a.state.events.slice(beforeA).find(e => e.type === "chat" && e.message.text.includes("loose floorboard"));
  const bGot = b.state.events.slice(beforeB).find(e => e.type === "chat" && e.message.text.includes("loose floorboard"));
  check(!!aGot, "Alice received the whisper");
  check(aGot?.message?.recipientId === pa_token, "Alice's copy is marked as a whisper (recipientId set)");
  check(!bGot, "Bob did NOT receive it");

  // Test 2: Bob's snapshot reload also doesn't expose past whispers to him.
  console.log("\n=== TEST 2: Bob reconnects → snapshot still hides Alice's whispers ===");
  b.ws.close();
  await rest(400);
  const b2 = connect(pb_token, "Bob-2");
  await rest(800);
  const whispersInBobSnapshot = b2.state.snapshot.chat.filter(m => m.recipientId === pa_token);
  check(whispersInBobSnapshot.length === 0, "Bob's snapshot chat has zero of Alice's whispers");

  // Test 3: AI invoked inside a whisper replies as a whisper.
  console.log("\n=== TEST 3: DM whisper '@dm tell Alice a secret hint' → AI reply stays whispered ===");
  const beforeA3 = a.state.events.length;
  const beforeB3 = b2.state.events.length;
  dm.ws.send(JSON.stringify({
    type: "chat", channel: "dm",
    text: "@dm in one sentence, give Alice a secret hint about the Tide Crow tavern. Keep it short.",
    recipientId: pa_token,
  }));
  // Wait for agent
  for (let i = 0; i < 45; i++) {
    if (a.state.events.slice(beforeA3).find(e => e.type === "dm.status" && e.state === "idle")) break;
    await rest(1000);
  }
  await rest(800);
  const aReplies = a.state.events.slice(beforeA3).filter(e => e.type === "chat" && e.message.authorRole === "agent");
  const bReplies = b2.state.events.slice(beforeB3).filter(e => e.type === "chat" && e.message.authorRole === "agent");
  check(aReplies.length >= 1, `Alice got the AI reply (${aReplies.length} agent message(s))`);
  check(aReplies[0]?.message?.recipientId === pa_token, "AI reply to Alice is itself a whisper");
  check(bReplies.length === 0, `Bob received NO agent replies (${bReplies.length})`);

  // Test 4: Roll request whisper → only Alice sees it; she resolves it; result visible to all (public roll).
  console.log("\n=== TEST 4: DM whispers a roll.request to Alice → she rolls → result ===");
  const beforeA4 = a.state.events.length;
  const beforeB4 = b2.state.events.length;
  dm.ws.send(JSON.stringify({ type: "roll.request", targetId: pa_token, label: "Stealth", dice: "1d20", dc: 13, whisper: true }));
  await rest(400);
  const aReq = a.state.events.slice(beforeA4).find(e => e.type === "roll.request");
  const bReq = b2.state.events.slice(beforeB4).find(e => e.type === "roll.request");
  check(!!aReq, "Alice received the roll.request");
  check(!bReq, "Bob did NOT receive the roll.request");
  if (aReq) {
    // Alice resolves it.
    a.ws.send(JSON.stringify({ type: "roll", notation: aReq.request.dice, label: aReq.request.label, rollRequestId: aReq.request.id }));
    await rest(400);
    const rollEv = a.state.events.find(e => e.type === "roll" && e.roll.notation === aReq.request.dice);
    check(!!rollEv, `Alice's roll resolved publicly (total=${rollEv?.roll?.total})`);
  }

  // Test 5: Player attempts to whisper → server downgrades to public.
  console.log("\n=== TEST 5: Player whisper attempt is downgraded to public ===");
  const before5 = dm.state.events.length;
  a.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "Bob, only you see this!", recipientId: pb_token }));
  await rest(300);
  const dmSaw = dm.state.events.slice(before5).find(e => e.type === "chat" && e.message.text.includes("only you see"));
  check(dmSaw && !dmSaw.message.recipientId, "DM saw it as a public message (recipientId stripped)");

  // Test 6: AI silent on plain chat (no @dm).
  console.log("\n=== TEST 6: Plain player chat does not invoke AI ===");
  const before6 = a.state.events.length;
  a.ws.send(JSON.stringify({ type: "chat", channel: "dm", text: "I look around the room." }));
  await rest(3500);
  const thinking6 = a.state.events.slice(before6).find(e => e.type === "dm.status" && e.state === "thinking");
  check(!thinking6, "no AI thinking event fired");

  // Test 7: Player tries to roll-request → rejected.
  console.log("\n=== TEST 7: Player tries to fire roll.request → server rejects ===");
  const before7 = a.state.errors.length;
  a.ws.send(JSON.stringify({ type: "roll.request", targetId: pb_token, label: "X", dice: "1d20" }));
  await rest(300);
  const err7 = a.state.errors.slice(before7).find(e => /DM-only/.test(e.message));
  check(!!err7, "player got DM-only error");

  // Test 8: Revoke Alice's invite mid-session → her connection drops + reconnect rejected.
  console.log("\n=== TEST 8: Revoke kicks Alice; reconnect with same token fails ===");
  await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites/${pa_token}/revoke`, {
    method: "POST", headers: { "x-invite-token": DM_TOKEN },
  });
  await rest(500);
  check(a.state.closed === true, "Alice's WS closed after revoke");
  const aRetry = connect(pa_token, "Alice-Retry");
  await rest(500);
  check(aRetry.state.errors.find(e => /invalid or revoked/.test(e.message)), "Re-connect with revoked token rejected");
  aRetry.ws.close();

  // Cleanup
  await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN}/invites/${pb_token}/revoke`, {
    method: "POST", headers: { "x-invite-token": DM_TOKEN },
  });
  dm.ws.close(); b2.ws.close();

  console.log(`\n=== ${failed === 0 ? "ALL PASSED" : `${failed} CHECK(S) FAILED`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
