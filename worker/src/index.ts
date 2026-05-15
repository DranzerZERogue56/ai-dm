import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { getDb } from "./db/client";
import { ensureCampaign, getCampaign, listCodex } from "./db/repo";
export { CampaignRoom } from "./campaign-room";

export interface Env {
  CAMPAIGN_ROOM: DurableObjectNamespace;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  AGENT_SHARED_SECRET: string;
  ALLOWED_ORIGINS?: string; // comma-separated list, e.g. "https://ai-dm.pages.dev,http://localhost:5173"
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return cors({
    origin: (origin) => (origin && allowed.includes(origin) ? origin : allowed[0] ?? "*"),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "x-invite-token", "x-agent-secret"],
  })(c, next);
});

app.get("/", (c) => c.text("ai-dm worker online"));

// Helper: call into a CampaignRoom DO via its admin path.
async function callRoom(env: Env, campaignId: string, path: string, init?: RequestInit) {
  const id = env.CAMPAIGN_ROOM.idFromName(campaignId);
  const stub = env.CAMPAIGN_ROOM.get(id);
  const url = `https://do/admin/${campaignId}/${path}`;
  return stub.fetch(url, init);
}

app.post("/api/campaigns", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body as any).name ?? "Untitled Campaign";
  const displayName = (body as any).displayName ?? "DM";
  const id = nanoid(10);
  const inviteCode = id;
  const db = getDb(c.env);
  if (db) {
    try {
      await ensureCampaign(db, { id, name, inviteCode });
    } catch (e) {
      console.error("[campaigns.create] persist failed:", e);
    }
  }
  // Auto-mint the DM invite.
  const r = await callRoom(c.env, id, "bootstrap-dm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const data = (await r.json()) as any;
  const dmInvite = data?.invite ?? null;
  return c.json({ id, name, inviteCode, persisted: !!db, dmInvite });
});

// Bootstrap a DM invite for an existing campaign that has none.
// Gated by AGENT_SHARED_SECRET so randoms can't hijack legacy rooms.
app.post("/api/campaigns/:id/bootstrap-dm", async (c) => {
  const id = c.req.param("id");
  const secret = c.req.header("x-agent-secret");
  if (!secret || secret !== c.env.AGENT_SHARED_SECRET) {
    return c.json({ error: "agent secret required" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const r = await callRoom(c.env, id, "bootstrap-dm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return c.json(await r.json(), r.status as any);
});

// Resolve an invite token (used by the lobby's ?inv= flow).
app.get("/api/invites/:token", async (c) => {
  const token = c.req.param("token");
  // Token format: "{role-prefix}_{nanoid}" but we don't know the campaign yet.
  // We require the campaign id in the query so we can route to the right DO.
  const campaignId = c.req.query("c");
  if (!campaignId) return c.json({ error: "missing ?c=<campaignId>" }, 400);
  const r = await callRoom(c.env, campaignId, `invites/${encodeURIComponent(token)}`);
  if (!r.ok) return c.json({ error: "not found" }, 404);
  return c.json(await r.json());
});

// DM-only: list invites for a campaign. Caller must include their own DM token.
app.get("/api/campaigns/:id/invites", async (c) => {
  const id = c.req.param("id");
  const requesterToken = c.req.header("x-invite-token") ?? c.req.query("t");
  if (!requesterToken) return c.json({ error: "x-invite-token header required" }, 401);
  // Verify the requester is a DM via the DO.
  const verify = await callRoom(c.env, id, `invites/${encodeURIComponent(requesterToken)}`);
  if (!verify.ok) return c.json({ error: "invalid token" }, 401);
  const v = (await verify.json()) as any;
  if (v?.invite?.role !== "dm" || v?.invite?.revokedAt) return c.json({ error: "DM only" }, 403);
  const r = await callRoom(c.env, id, "invites");
  return c.json(await r.json());
});

// DM-only: create an invite.
app.post("/api/campaigns/:id/invites", async (c) => {
  const id = c.req.param("id");
  const requesterToken = c.req.header("x-invite-token");
  if (!requesterToken) return c.json({ error: "x-invite-token header required" }, 401);
  const verify = await callRoom(c.env, id, `invites/${encodeURIComponent(requesterToken)}`);
  if (!verify.ok) return c.json({ error: "invalid token" }, 401);
  const v = (await verify.json()) as any;
  if (v?.invite?.role !== "dm" || v?.invite?.revokedAt) return c.json({ error: "DM only" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const r = await callRoom(c.env, id, "invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return c.json(await r.json(), r.status as any);
});

// DM-only: revoke an invite.
app.post("/api/campaigns/:id/invites/:token/revoke", async (c) => {
  const id = c.req.param("id");
  const token = c.req.param("token");
  const requesterToken = c.req.header("x-invite-token");
  if (!requesterToken) return c.json({ error: "x-invite-token header required" }, 401);
  const verify = await callRoom(c.env, id, `invites/${encodeURIComponent(requesterToken)}`);
  if (!verify.ok) return c.json({ error: "invalid token" }, 401);
  const v = (await verify.json()) as any;
  if (v?.invite?.role !== "dm" || v?.invite?.revokedAt) return c.json({ error: "DM only" }, 403);
  const r = await callRoom(c.env, id, `invites/${encodeURIComponent(token)}/revoke`, { method: "POST" });
  return c.json(await r.json(), r.status as any);
});

app.get("/api/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env);
  if (!db) return c.json({ id, exists: true, persisted: false, codex: [] });
  try {
    const row = await getCampaign(db, id);
    if (!row) return c.json({ id, exists: false, persisted: true, codex: [] }, 404);
    const codex = await listCodex(db, id);
    return c.json({ id, name: row.name, exists: true, persisted: true, codex });
  } catch (e) {
    console.error("[campaigns.get] failed:", e);
    return c.json({ id, exists: false, error: String(e) }, 500);
  }
});

app.get("/ws/:campaignId", (c) => {
  const upgrade = c.req.header("Upgrade");
  if (upgrade !== "websocket") return c.text("expected websocket upgrade", 426);
  const id = c.env.CAMPAIGN_ROOM.idFromName(c.req.param("campaignId"));
  const stub = c.env.CAMPAIGN_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
