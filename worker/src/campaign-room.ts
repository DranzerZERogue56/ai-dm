import { nanoid } from "nanoid";
import type {
  ClientToServer,
  ServerToClient,
  Participant,
  CodexEntry,
  CombatState,
  CampaignMode,
  ChatMessage,
  Invite,
  RollRequest,
} from "@ai-dm/shared";

const CHAT_CAP = 5000;
import type { Env } from "./index";
import { getDb } from "./db/client";
import { listCodex, upsertCodex, deleteCodex, insertChat, recentChat, upsertInvite, listInvites } from "./db/repo";

interface Session {
  ws: WebSocket;
  participant: Participant;
}

export class CampaignRoom {
  private sessions = new Map<string, Session>();
  private codex = new Map<string, CodexEntry>();
  private combat: CombatState = { active: false, round: 0, turnIndex: 0, combatants: [] };
  private mode: CampaignMode = "worldbuilder";
  private chat: ChatMessage[] = [];
  private invites = new Map<string, Invite>();
  private aiPaused = false;
  private hydratedFor: string | null = null;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);
    // /ws/:campaignId  → WebSocket
    // /admin/:campaignId/invites/...  → admin RPC from the public worker
    if (segs[0] === "admin") {
      const campaignId = segs[1] ?? "unknown";
      await this.hydrate(campaignId);
      return this.handleAdmin(req, campaignId, segs.slice(2));
    }
    const campaignId = segs[segs.length - 1] ?? "unknown";
    await this.hydrate(campaignId);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.attach(server, campaignId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleAdmin(req: Request, campaignId: string, path: string[]): Promise<Response> {
    // path: ["invites"] | ["invites", token, "revoke"] | ["invites", token] | ["bootstrap-dm"]
    const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (path[0] === "invites" && !path[1]) {
      if (req.method === "GET") {
        // List all invites (DM-only — caller is responsible for checking)
        return json({ invites: [...this.invites.values()] });
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as any;
        if (body?.role !== "dm" && body?.role !== "player") return json({ error: "role must be dm or player" }, 400);
        const inv: Invite = {
          token: `${body.role === "dm" ? "dm" : "p"}_${nanoid(10)}`,
          campaignId,
          displayName: String(body.displayName ?? `${body.role}-${nanoid(4)}`).slice(0, 60),
          role: body.role,
          pcId: body.pcId ? String(body.pcId) : undefined,
          createdAt: new Date().toISOString(),
        };
        this.invites.set(inv.token, inv);
        this.persistInvite(inv);
        return json({ invite: inv });
      }
      return json({ error: "method" }, 405);
    }
    if (path[0] === "invites" && path[1] && path[2] === "revoke" && req.method === "POST") {
      const inv = this.invites.get(path[1]);
      if (!inv) return json({ error: "not found" }, 404);
      inv.revokedAt = new Date().toISOString();
      this.persistInvite(inv);
      // Boot anyone currently connected with that token.
      for (const s of this.sessions.values()) {
        if (s.participant.id === path[1]) {
          try { s.ws.close(4001, "invite revoked"); } catch {}
        }
      }
      return json({ invite: inv });
    }
    if (path[0] === "invites" && path[1] && !path[2] && req.method === "GET") {
      const inv = this.invites.get(path[1]);
      if (!inv) return json({ error: "not found" }, 404);
      return json({ invite: inv });
    }
    if (path[0] === "bootstrap-dm" && req.method === "POST") {
      // One-time bootstrap: if no DM invite exists yet, mint one.
      const existing = [...this.invites.values()].find((i) => i.role === "dm" && !i.revokedAt);
      if (existing) return json({ invite: existing, bootstrapped: false });
      const body = await req.json().catch(() => ({})) as any;
      const inv: Invite = {
        token: `dm_${nanoid(10)}`,
        campaignId,
        displayName: String(body?.displayName ?? "DM").slice(0, 60),
        role: "dm",
        createdAt: new Date().toISOString(),
      };
      this.invites.set(inv.token, inv);
      this.persistInvite(inv);
      return json({ invite: inv, bootstrapped: true });
    }
    return json({ error: "not found" }, 404);
  }

  private persistInvitesToStorage() {
    this.state.waitUntil(
      this.state.storage.put("invites", [...this.invites.values()]).catch((e) =>
        console.error("[storage] invites put failed:", e)
      )
    );
  }
  private persistInvite(inv: Invite) {
    this.persistInvitesToStorage();
    const db = getDb(this.env);
    if (!db) return;
    this.state.waitUntil(upsertInvite(db, inv).catch((e) => console.error("[db] invite upsert failed:", e)));
  }

  private async hydrate(campaignId: string) {
    if (this.hydratedFor === campaignId) return;
    const db = getDb(this.env);
    // Prefer DB when present; otherwise fall back to DO state.storage (survives wrangler restarts).
    if (db) {
      try {
        const [codexRows, chatRows, inviteRows] = await Promise.all([
          listCodex(db, campaignId),
          recentChat(db, campaignId).catch(() => []),
          listInvites(db, campaignId).catch(() => []),
        ]);
        this.codex.clear();
        for (const r of codexRows) this.codex.set(r.id, r);
        if (chatRows.length) this.chat = chatRows;
        if (inviteRows.length) {
          this.invites.clear();
          for (const i of inviteRows) this.invites.set(i.token, i);
        }
        // Still load mode/combat/aiPaused from DO storage (no DB columns for those yet).
        const [storedMode, storedCombat, storedAiPaused] = await Promise.all([
          this.state.storage.get<CampaignMode>("mode"),
          this.state.storage.get<CombatState>("combat"),
          this.state.storage.get<boolean>("aiPaused"),
        ]);
        if (storedMode) this.mode = storedMode;
        if (storedCombat) this.combat = storedCombat;
        if (typeof storedAiPaused === "boolean") this.aiPaused = storedAiPaused;
        console.log(`[room ${campaignId}] hydrated ${codexRows.length} codex / ${chatRows.length} chat / ${inviteRows.length} invites from DB`);
      } catch (e) {
        console.error(`[room ${campaignId}] DB hydrate failed, falling back to storage:`, e);
        await this.hydrateFromStorage(campaignId);
      }
    } else {
      await this.hydrateFromStorage(campaignId);
    }
    this.hydratedFor = campaignId;
  }

  private async hydrateFromStorage(campaignId: string) {
    const [storedCodex, storedMode, storedCombat, storedChat, storedInvites, storedAiPaused] = await Promise.all([
      this.state.storage.get<CodexEntry[]>("codex"),
      this.state.storage.get<CampaignMode>("mode"),
      this.state.storage.get<CombatState>("combat"),
      this.state.storage.get<ChatMessage[]>("chat"),
      this.state.storage.get<Invite[]>("invites"),
      this.state.storage.get<boolean>("aiPaused"),
    ]);
    if (storedCodex) {
      this.codex.clear();
      for (const r of storedCodex) this.codex.set(r.id, r);
    }
    if (storedMode) this.mode = storedMode;
    if (storedCombat) this.combat = storedCombat;
    if (storedChat) this.chat = storedChat;
    if (storedInvites) {
      this.invites.clear();
      for (const i of storedInvites) this.invites.set(i.token, i);
    }
    if (typeof storedAiPaused === "boolean") this.aiPaused = storedAiPaused;
    console.log(`[room ${campaignId}] hydrated ${this.codex.size} codex / ${this.chat.length} chat / ${this.invites.size} invites${this.aiPaused ? " (AI paused)" : ""} from DO storage`);
  }

  private persistChatToStorage() {
    this.state.waitUntil(
      this.state.storage.put("chat", this.chat.slice(-CHAT_CAP)).catch((e) =>
        console.error("[storage] chat put failed:", e)
      )
    );
  }
  private persistChatMessage(message: ChatMessage) {
    this.persistChatToStorage();
    const db = getDb(this.env);
    if (!db) return;
    this.state.waitUntil(insertChat(db, message).catch((e) => console.error("[db] chat insert failed:", e)));
  }

  private persistCodexToStorage() {
    this.state.waitUntil(
      this.state.storage.put("codex", [...this.codex.values()]).catch((e) =>
        console.error("[storage] codex put failed:", e)
      )
    );
  }
  private persistModeToStorage() {
    this.state.waitUntil(this.state.storage.put("mode", this.mode).catch(() => {}));
  }
  private persistCombatToStorage() {
    this.state.waitUntil(this.state.storage.put("combat", this.combat).catch(() => {}));
  }

  private persistUpsert(entry: CodexEntry) {
    this.persistCodexToStorage();
    const db = getDb(this.env);
    if (!db) return;
    this.state.waitUntil(
      upsertCodex(db, entry).catch((e) => console.error("[codex.upsert] persist failed:", e))
    );
  }

  private persistDelete(campaignId: string, id: string) {
    this.persistCodexToStorage();
    const db = getDb(this.env);
    if (!db) return;
    this.state.waitUntil(
      deleteCodex(db, campaignId, id).catch((e) => console.error("[codex.delete] persist failed:", e))
    );
  }

  private attach(ws: WebSocket, campaignId: string) {
    const id = nanoid(8);
    const session: Session = {
      ws,
      participant: { id, displayName: `guest-${id}`, role: "player" },
    };
    this.sessions.set(id, session);

    ws.addEventListener("message", (evt) => {
      let msg: ClientToServer;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer));
      } catch {
        this.send(ws, { type: "error", message: "invalid json" });
        return;
      }
      this.handle(session, msg, campaignId);
    });
    ws.addEventListener("close", () => {
      this.sessions.delete(id);
      this.broadcastParticipants();
    });
  }

  private handle(session: Session, msg: ClientToServer, campaignId: string) {
    switch (msg.type) {
      case "hello": {
        // Auth: agent uses AGENT_SHARED_SECRET; everyone else uses an invite token.
        const claimedRole = msg.role ?? "player";
        if (claimedRole === "agent") {
          if (!msg.token || msg.token !== this.env.AGENT_SHARED_SECRET) {
            this.send(session.ws, { type: "error", message: "invalid agent secret" });
            try { session.ws.close(4003, "invalid agent secret"); } catch {}
            this.sessions.delete(session.participant.id);
            return;
          }
          session.participant.displayName = msg.displayName || "AI-DM";
          session.participant.role = "agent";
        } else {
          if (!msg.token) {
            this.send(session.ws, { type: "error", message: "invite token required" });
            try { session.ws.close(4003, "missing token"); } catch {}
            this.sessions.delete(session.participant.id);
            return;
          }
          const inv = this.invites.get(msg.token);
          if (!inv || inv.revokedAt) {
            this.send(session.ws, { type: "error", message: "invalid or revoked invite" });
            try { session.ws.close(4003, "bad token"); } catch {}
            this.sessions.delete(session.participant.id);
            return;
          }
          // Server-side identity wins. We ignore client-claimed role/name.
          // We reassign the session id to the token so we can target it later (e.g. on revoke).
          this.sessions.delete(session.participant.id);
          session.participant = {
            id: inv.token,
            displayName: inv.displayName,
            role: inv.role,
            pcId: inv.pcId,
          };
          this.sessions.set(inv.token, session);
          inv.lastUsedAt = new Date().toISOString();
          this.persistInvite(inv);
        }
        this.send(session.ws, {
          type: "snapshot",
          campaignId,
          mode: this.mode,
          codex: [...this.codex.values()].filter((e) => this.canSeeEntry(e, session)),
          combat: this.combat,
          participants: this.participants(),
          persistence: { storage: true, db: !!getDb(this.env) },
          chat: this.chat.slice(-CHAT_CAP).filter((m) => this.canSeeChat(m, session)),
          aiPaused: this.aiPaused,
        });
        this.broadcastParticipants();
        return;
      }
      case "chat": {
        // Only DMs / agent may target a whisper. Players cannot whisper.
        const canWhisper = session.participant.role === "dm" || session.participant.role === "agent";
        const recipientId = msg.recipientId && canWhisper ? msg.recipientId : undefined;
        // Only DMs / agent may speak-as-NPC. Players cannot impersonate.
        const speakAsNpcId = msg.speakAsNpcId && canWhisper ? msg.speakAsNpcId : undefined;
        const npcEntry = speakAsNpcId ? this.codex.get(speakAsNpcId) : undefined;
        const message: ChatMessage = {
          id: nanoid(10),
          campaignId,
          channel: msg.channel,
          authorId: session.participant.id,
          authorName: session.participant.displayName,
          authorRole: session.participant.role,
          text: msg.text,
          recipientId,
          invokeAi: msg.invokeAi,
          speakAsNpcId,
          speakAsNpcName: npcEntry?.title,
          createdAt: new Date().toISOString(),
        };
        this.chat.push(message);
        if (this.chat.length > CHAT_CAP) this.chat = this.chat.slice(-CHAT_CAP);
        this.persistChatMessage(message);
        this.broadcastPerSession((s) => this.canSeeChat(message, s) ? { type: "chat", message } : null);
        return;
      }
      case "roll": {
        const roll = rollDice(msg.notation);
        this.broadcast({
          type: "roll",
          roll: {
            id: nanoid(10),
            authorId: session.participant.id,
            authorName: session.participant.displayName,
            notation: msg.notation,
            rolls: roll.rolls,
            total: roll.total,
            label: msg.label,
            createdAt: new Date().toISOString(),
          },
        });
        return;
      }
      case "codex.upsert": {
        const now = new Date().toISOString();
        const id = (msg.entry.id as string) ?? nanoid(10);
        const existing = this.codex.get(id);
        const entry: CodexEntry = {
          id,
          campaignId,
          kind: msg.entry.kind,
          title: msg.entry.title,
          body: msg.entry.body,
          sections: msg.entry.sections ?? existing?.sections,
          tags: msg.entry.tags ?? existing?.tags,
          links: msg.entry.links ?? existing?.links,
          data: msg.entry.data,
          imageUrl: msg.entry.imageUrl,
          visibility: msg.entry.visibility ?? "public",
          ownerId: msg.entry.ownerId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.codex.set(id, entry);
        this.persistUpsert(entry);
        // TODO: embed body via embeddings API + update vector column
        // Per-session visibility: send upsert if visible, hide if it was previously visible and now isn't.
        this.broadcastPerSession((s) => {
          const canSeeNow = this.canSeeEntry(entry, s);
          const couldSeeBefore = existing ? this.canSeeEntry(existing, s) : false;
          if (canSeeNow) return { type: "codex.upsert", entry };
          if (couldSeeBefore) return { type: "codex.hide", id: entry.id };
          return null;
        });
        return;
      }
      case "codex.delete":
        this.codex.delete(msg.id);
        this.persistDelete(campaignId, msg.id);
        this.broadcast({ type: "codex.delete", id: msg.id });
        return;
      case "combat.update":
        if (session.participant.role !== "dm" && session.participant.role !== "agent") {
          this.send(session.ws, { type: "error", message: "combat.update is DM-only" });
          return;
        }
        this.combat = msg.state;
        this.persistCombatToStorage();
        this.broadcast({ type: "combat.update", state: this.combat });
        return;
      case "ai.pause": {
        if (session.participant.role !== "dm") {
          this.send(session.ws, { type: "error", message: "ai.pause is DM-only" });
          return;
        }
        this.aiPaused = !!msg.paused;
        this.state.waitUntil(this.state.storage.put("aiPaused", this.aiPaused).catch(() => {}));
        this.broadcast({ type: "ai.paused", paused: this.aiPaused });
        return;
      }
      case "roll.request": {
        if (session.participant.role !== "dm") {
          this.send(session.ws, { type: "error", message: "roll.request is DM-only" });
          return;
        }
        const req: RollRequest = {
          id: nanoid(10),
          fromId: session.participant.id,
          fromName: session.participant.displayName,
          targetId: msg.targetId,
          label: msg.label,
          dice: msg.dice,
          dc: msg.dc,
          whisper: !!msg.whisper,
          createdAt: new Date().toISOString(),
        };
        // Whisper: DM + target only. Else: everyone.
        this.broadcastPerSession((s) => {
          if (!req.whisper) return { type: "roll.request", request: req };
          if (s.participant.role === "dm" || s.participant.role === "agent" || s.participant.id === req.targetId) {
            return { type: "roll.request", request: req };
          }
          return null;
        });
        return;
      }
      case "mode.set": {
        const prev = this.mode;
        this.mode = msg.mode;
        this.persistModeToStorage();
        this.broadcast({ type: "mode.set", mode: this.mode });
        // Auto-wrap: leaving play mode triggers a session summary.
        if (prev === "play" && msg.mode === "worldbuilder") {
          this.broadcast({ type: "session.wrapup", reason: "mode_switch" });
        }
        return;
      }
      case "session.wrapup":
        this.broadcast({ type: "session.wrapup", reason: msg.reason });
        return;
      case "codex.audit":
        this.broadcast({ type: "codex.audit", reason: msg.reason });
        return;
      case "dm.status":
        // Only the agent should emit this; pass through.
        if (session.participant.role !== "agent") return;
        this.broadcast({ type: "dm.status", state: msg.state, detail: msg.detail });
        return;
      case "dm.partial":
        if (session.participant.role !== "agent") return;
        this.broadcast({ type: "dm.partial", partial: msg.partial });
        return;
    }
  }

  private participants(): Participant[] {
    return [...this.sessions.values()].map((s) => s.participant);
  }

  private broadcastParticipants() {
    this.broadcast({ type: "participants", participants: this.participants() });
  }

  private broadcast(msg: ServerToClient) {
    const data = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      try {
        s.ws.send(data);
      } catch {}
    }
  }

  // Build a per-session payload. If buildMsg returns null, that session gets nothing.
  private broadcastPerSession(buildMsg: (s: Session) => ServerToClient | null) {
    for (const s of this.sessions.values()) {
      const m = buildMsg(s);
      if (!m) continue;
      try { s.ws.send(JSON.stringify(m)); } catch {}
    }
  }

  private send(ws: WebSocket, msg: ServerToClient) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  // Visibility filter — server-side privacy. DM and agent see everything.
  private canSeeEntry(entry: CodexEntry, s: Session): boolean {
    if (s.participant.role === "dm" || s.participant.role === "agent") return true;
    if (entry.visibility === "public") return true;
    if (entry.visibility === "player") return !entry.ownerId || entry.ownerId === s.participant.id;
    return false; // "dm" visibility blocks players
  }
  private canSeeChat(msg: ChatMessage, s: Session): boolean {
    if (!msg.recipientId) return true; // public message
    if (s.participant.role === "dm" || s.participant.role === "agent") return true;
    return msg.authorId === s.participant.id || msg.recipientId === s.participant.id;
  }
}

function rollDice(notation: string): { rolls: number[]; total: number } {
  // e.g. "2d20+5"
  const m = notation.replace(/\s+/g, "").match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return { rolls: [], total: 0 };
  const count = Math.max(1, Math.min(100, parseInt(m[1] || "1")));
  const sides = Math.max(2, Math.min(1000, parseInt(m[2])));
  const mod = m[3] ? parseInt(m[3]) : 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(Math.random() * sides));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) + mod };
}
