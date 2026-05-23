import { WebSocket } from "ws";
import type { ClientToServer, ServerToClient, CodexEntry, CombatState } from "@ai-dm/shared";
import { runDmTurn } from "./dm-agent";
import { runHelperTurn } from "./player-helper";
import { runAuditTurn } from "./audit-agent";
import { scheduleMdWrite, mdPathFor } from "./md-mirror";
import { scheduleVaultWrite, vaultRootFor } from "./obsidian-vault";
import { scanVault } from "./vault-ingest";

const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT;
function syncMirrors() {
  scheduleMdWrite(CAMPAIGN_ID!, state.codex);
  if (OBSIDIAN_VAULT) scheduleVaultWrite(OBSIDIAN_VAULT, CAMPAIGN_ID!, state.codex);
}

const WORKER_WS = process.env.WORKER_WS ?? "ws://127.0.0.1:8787";
const CAMPAIGN_ID = process.env.CAMPAIGN_ID;
const SHARED_SECRET = process.env.AGENT_SHARED_SECRET ?? "change-me-in-dev-vars";

if (!CAMPAIGN_ID) {
  console.error("CAMPAIGN_ID env var required");
  process.exit(1);
}

interface ChatEntry {
  id?: string;
  author: string;
  text: string;
  channel: "dm" | "assistant";
  role: "dm" | "player" | "agent" | "system";
  createdAt?: string;
}

interface RoomState {
  mode: "worldbuilder" | "play";
  codex: CodexEntry[];
  combat: CombatState;
  recentChat: ChatEntry[];
  fullChat: ChatEntry[];
  aiPaused: boolean;
}

const CHAT_CAP = 5000;

const state: RoomState = {
  mode: "worldbuilder",
  codex: [],
  combat: { active: false, round: 0, turnIndex: 0, combatants: [] },
  recentChat: [],
  fullChat: [],
  aiPaused: false,
};

let ws: WebSocket;
let backoffMs = 500;

function send(msg: ClientToServer) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`${WORKER_WS}/ws/${CAMPAIGN_ID}`);

  ws.on("open", () => {
    const vaultRoot = vaultRootFor(CAMPAIGN_ID!);
    console.log(`[agent] connected as ai-dm; .md mirror -> ${mdPathFor(CAMPAIGN_ID!)}${vaultRoot ? `; obsidian vault -> ${vaultRoot}` : ""}`);
    backoffMs = 500;
    send({ type: "hello", campaignId: CAMPAIGN_ID!, displayName: "AI-DM", role: "agent", token: SHARED_SECRET });
  });

  ws.on("close", () => {
    console.log(`[agent] disconnected, retrying in ${backoffMs}ms`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  });

  ws.on("error", (e) => console.error("[agent] ws error", (e as Error).message));

  ws.on("message", handleMessage);
}

async function handleMessage(raw: Buffer) {
  let msg: ServerToClient;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  switch (msg.type) {
    case "snapshot":
      state.mode = msg.mode;
      state.codex = msg.codex;
      state.combat = msg.combat;
      state.aiPaused = !!msg.aiPaused;
      state.fullChat = msg.chat.map((m) => ({
        id: m.id, author: m.authorName, text: m.text, channel: m.channel, role: m.authorRole, createdAt: m.createdAt,
      }));
      state.recentChat = state.fullChat.slice(-40);
      // Don't auto-sync the vault on snapshot — that would clobber user edits
      // between codex changes. The vault is updated when the codex actually
      // changes (codex.upsert / codex.delete) or via the one-shot exporter.
      scheduleMdWrite(CAMPAIGN_ID!, state.codex);
      break;
    case "ai.paused":
      state.aiPaused = msg.paused;
      console.log(`[agent] ai ${state.aiPaused ? "paused" : "resumed"}`);
      break;
    case "vault.scan": {
      if (!OBSIDIAN_VAULT) {
        send({ type: "vault.diff", requestId: msg.requestId, changes: [], scannedFiles: 0, error: "OBSIDIAN_VAULT not set on the agent" });
        break;
      }
      try {
        const r = await scanVault(OBSIDIAN_VAULT, CAMPAIGN_ID!, state.codex);
        console.log(`[agent] vault.scan: ${r.scannedFiles} files, ${r.changes.length} changes`);
        send({ type: "vault.diff", requestId: msg.requestId, changes: r.changes as any, scannedFiles: r.scannedFiles });
      } catch (e) {
        send({ type: "vault.diff", requestId: msg.requestId, changes: [], scannedFiles: 0, error: (e as Error).message });
      }
      break;
    }
    case "vault.apply": {
      const valid = (msg.changes ?? []).filter((c) => c && c.next && (c.next as any).id);
      for (const c of valid) {
        // Update local state immediately so any chat-driven AI turn that arrives
        // milliseconds later already sees the vault-sourced codex.
        const i = state.codex.findIndex((e) => e.id === (c.next as any).id);
        if (i >= 0) state.codex[i] = { ...state.codex[i], ...(c.next as any) };
        else state.codex.push(c.next as any);
        send({ type: "codex.upsert", entry: c.next as any });
      }
      console.log(`[agent] vault.apply: ${valid.length} entries upserted${valid.length !== (msg.changes?.length ?? 0) ? ` (${(msg.changes?.length ?? 0) - valid.length} skipped)` : ""}`);
      break;
    }
    case "codex.upsert": {
      const i = state.codex.findIndex((e) => e.id === msg.entry.id);
      if (i >= 0) state.codex[i] = msg.entry; else state.codex.push(msg.entry);
      syncMirrors();
      break;
    }
    case "codex.delete":
      state.codex = state.codex.filter((e) => e.id !== msg.id);
      syncMirrors();
      break;
    case "combat.update": state.combat = msg.state; break;
    case "mode.set": state.mode = msg.mode; break;
    case "codex.audit": {
      console.log(`[agent] codex.audit received (reason=${msg.reason}) — ${state.codex.length} entries, ${state.fullChat.length} chat messages`);
      send({ type: "dm.status", state: "thinking", detail: `auditing ${state.codex.length} entries against ${state.fullChat.length} chat messages` });
      try {
        const reply = await runAuditTurn({
          codex: state.codex,
          chat: state.fullChat,
          cb: { onPartial: (p) => send({ type: "dm.partial", partial: p }) },
        });
        if (reply.narration) send({ type: "chat", channel: "dm", text: reply.narration });
        for (const u of reply.codexUpserts ?? []) send({ type: "codex.upsert", entry: u });
        for (const id of reply.codexDeletes ?? []) send({ type: "codex.delete", id });
      } finally {
        send({ type: "dm.status", state: "idle" });
      }
      break;
    }
    case "session.wrapup": {
      send({ type: "dm.status", state: "thinking", detail: "wrapping up session" });
      try {
        const directive = [
          "[SYSTEM DIRECTIVE — session wrapup]",
          `Reason: ${msg.reason ?? "manual"}.`,
          "The play session is ending. Do the following in one turn:",
          "1. Call codex_upsert with kind='session_note', a short evocative title (date or scene), and a markdown body covering: scenes/locations visited, NPCs encountered, quest progress, notable character moments, anything new for the world.",
          "2. After the tool call, reply with a 2-3 sentence epilogue in second person.",
          "Do not ask the players questions. Do not start a new scene.",
        ].join("\n");
        const reply = await runDmTurn(state, directive, {
          onPartial: (p) => send({ type: "dm.partial", partial: p }),
        });
        if (reply.narration) send({ type: "chat", channel: "dm", text: reply.narration });
        for (const u of reply.codexUpserts ?? []) send({ type: "codex.upsert", entry: u });
        for (const id of reply.codexDeletes ?? []) send({ type: "codex.delete", id });
      } finally {
        send({ type: "dm.status", state: "idle" });
      }
      break;
    }
    case "chat": {
      {
        const entry: ChatEntry = {
          id: msg.message.id,
          author: msg.message.authorName,
          text: msg.message.text,
          channel: msg.message.channel,
          role: msg.message.authorRole,
          createdAt: msg.message.createdAt,
        };
        if (!state.fullChat.some((m) => m.id === entry.id)) state.fullChat.push(entry);
        if (state.fullChat.length > CHAT_CAP) state.fullChat = state.fullChat.slice(-CHAT_CAP);
        state.recentChat = state.fullChat.slice(-40);
      }
      // DM channel: AI is SILENT by default. It only responds when the human
      // explicitly invokes it via invokeAi=true OR a leading "@dm " prefix.
      // The aiPaused room flag overrides invocation entirely.
      if (msg.message.channel === "dm" && msg.message.authorRole !== "agent") {
        const raw = msg.message.text ?? "";
        const prefixed = /^\s*@dm(?:\b|\s)/i.test(raw);
        const invoke = msg.message.invokeAi === true || prefixed;
        if (!invoke || state.aiPaused) break;
        const promptText = prefixed ? raw.replace(/^\s*@dm\s*/i, "").trim() : raw;
        // If the invocation came from a whisper, the response stays whispered
        // to that recipient. Otherwise it's a public reply.
        const replyRecipient = msg.message.recipientId;
        send({ type: "dm.status", state: "thinking" });
        try {
          const reply = await runDmTurn(state, promptText, {
            onPartial: (p) => send({ type: "dm.partial", partial: p }),
          });
          if (reply.narration) send({ type: "chat", channel: "dm", text: reply.narration, recipientId: replyRecipient });
          for (const u of reply.codexUpserts ?? []) send({ type: "codex.upsert", entry: u });
          for (const id of reply.codexDeletes ?? []) send({ type: "codex.delete", id });
          if (reply.combat) send({ type: "combat.update", state: reply.combat });
          if (reply.mode) send({ type: "mode.set", mode: reply.mode });
        } finally {
          send({ type: "dm.status", state: "idle" });
        }
      }
      // Assistant channel: route to the lighter Player Helper agent (skip our own).
      if (msg.message.channel === "assistant" && msg.message.authorRole !== "agent") {
        const text = await runHelperTurn(
          { codex: state.codex, recentChat: state.recentChat.map((m) => ({ author: m.author, text: m.text })) },
          msg.message.authorName,
          msg.message.text
        );
        send({ type: "chat", channel: "assistant", text });
      }
      break;
    }
  }
}

connect();
