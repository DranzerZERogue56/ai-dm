import { WebSocket } from "ws";

const CAMPAIGN_ID = process.env.CAMPAIGN_ID ?? "fJJLZa1Bd6";
const DM_TOKEN   = process.env.DM_TOKEN ?? "dm_IkOF5bUyfz";

async function trial(label, hello, expect) {
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${CAMPAIGN_ID}`);
  let snapshotSeen = false;
  let errSeen = null;
  let closed = false;
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "snapshot") snapshotSeen = true;
    if (m.type === "error") errSeen = m.message;
  });
  ws.on("close", () => { closed = true; });
  await new Promise((res) => setTimeout(res, 1500));
  ws.close();
  const pass = expect === "ok" ? snapshotSeen : !!errSeen;
  console.log(`${pass ? "✓" : "✗"} ${label} — snapshot=${snapshotSeen} err=${errSeen}`);
  return pass;
}

// 1. No token: should reject
const t1 = await trial("no-token-rejected",
  { type: "hello", campaignId: CAMPAIGN_ID, displayName: "Anon", role: "player" },
  "error");

// 2. Bogus token: should reject
const t2 = await trial("bogus-token-rejected",
  { type: "hello", campaignId: CAMPAIGN_ID, displayName: "Anon", role: "player", token: "p_doesnt_exist" },
  "error");

// 3. Valid DM token: should accept
const t3 = await trial("valid-dm-accepts",
  { type: "hello", campaignId: CAMPAIGN_ID, displayName: "ignored", role: "player", token: DM_TOKEN },
  "ok");

// 4. Create an invite via API
const res = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN_ID}/invites`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-invite-token": DM_TOKEN },
  body: JSON.stringify({ displayName: "Test Player", role: "player" }),
});
const data = await res.json();
console.log(`${data.invite ? "✓" : "✗"} player-invite-created — token=${data.invite?.token}`);
const playerToken = data.invite?.token;

// 5. Player token works
const t5 = playerToken ? await trial("player-token-accepts",
  { type: "hello", campaignId: CAMPAIGN_ID, displayName: "ignored", role: "dm", token: playerToken },
  "ok") : false;

// 6. List invites with DM token
const list = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN_ID}/invites`, {
  headers: { "x-invite-token": DM_TOKEN },
});
const listData = await list.json();
console.log(`${listData.invites?.length >= 2 ? "✓" : "✗"} invite-list — count=${listData.invites?.length}`);

// 7. Revoke player invite, then try to connect with it
if (playerToken) {
  const rv = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN_ID}/invites/${playerToken}/revoke`, {
    method: "POST",
    headers: { "x-invite-token": DM_TOKEN },
  });
  console.log(`revoke status=${rv.status}`);
  const t7 = await trial("revoked-token-rejected",
    { type: "hello", campaignId: CAMPAIGN_ID, displayName: "Anon", role: "player", token: playerToken },
    "error");
}

// 8. Non-DM can't list invites
if (playerToken) {
  const denied = await fetch(`http://localhost:8787/api/campaigns/${CAMPAIGN_ID}/invites`, {
    headers: { "x-invite-token": playerToken },
  });
  console.log(`${denied.status === 403 ? "✓" : "✗"} non-dm-list-denied — status=${denied.status}`);
}

process.exit(0);
