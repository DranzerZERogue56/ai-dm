import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, CodexEntry, CodexKind, DmPartial, DmStatus, Participant, PersistenceInfo, ServerToClient, CampaignMode } from "@ai-dm/shared";
import { RoomSocket } from "./lib/ws";
import { CodexPanel } from "./components/CodexPanel";
import { DMChat } from "./components/DMChat";
import { Lobby } from "./components/Lobby";
import { CodexTicker } from "./components/CodexTicker";
import { CodexPage } from "./components/CodexPage";
import { InviteManager } from "./components/InviteManager";
import { beep, getSoundEnabled, setSoundEnabled } from "./lib/beep";
import { computeChange, type CodexChangeMap } from "./lib/codex-changes";

const BANNER = `
  ___   _____      ____  __  __
 / _ \\ |_   _|    |  _ \\|  \\/  |
| |_| |  | |  ___ | | | | |\\/| |
|  _  |  | | |___|| |_| | |  | |
|_| |_|  |_|      |____/|_|  |_|   CAMPAIGN TERMINAL v0.1
`;

function PersistenceBadge({ info }: { info: PersistenceInfo | null }) {
  if (!info) return <span className="persist-badge persist-pending">connecting…</span>;
  const isPersisted = info.storage || info.db;
  const cls = isPersisted ? "persist-badge persist-ok" : "persist-badge persist-bad";
  const label = isPersisted ? "PERSISTED" : "EPHEMERAL ⚠";
  const detail = isPersisted
    ? `saved to: ${[info.db && "Postgres", info.storage && "DO storage"].filter(Boolean).join(" + ")}`
    : "WARNING: codex changes are in-memory only and will be lost on worker restart.";
  return <span className={cls} title={detail}>{label}</span>;
}

function readCampaignFromUrl(): string | null {
  const p = new URLSearchParams(window.location.search);
  return p.get("c");
}
function writeCampaignToUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("c", id); else url.searchParams.delete("c");
  window.history.replaceState({}, "", url.toString());
}

export function App() {
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [role, setRole] = useState<"dm" | "player">("player");
  const [token, setToken] = useState<string>("");

  useEffect(() => { writeCampaignToUrl(campaignId); }, [campaignId]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [codex, setCodex] = useState<CodexEntry[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [mode, setMode] = useState<CampaignMode>("worldbuilder");
  const [dmStatus, setDmStatus] = useState<DmStatus>("idle");
  const [dmPartial, setDmPartial] = useState<DmPartial>({});
  const [buildLog, setBuildLog] = useState<{ name: string; preview?: string }[]>([]);
  const [persistence, setPersistence] = useState<PersistenceInfo | null>(null);
  const [codexChanges, setCodexChanges] = useState<CodexChangeMap>({});
  const [lastSeenByKind, setLastSeenByKind] = useState<Record<string, number>>({});
  const [soundOn, setSoundOnState] = useState<boolean>(() => getSoundEnabled());
  const [view, setView] = useState<"room" | "codex">(() => (new URLSearchParams(window.location.search).get("v") === "codex" ? "codex" : "room"));
  const [aiPaused, setAiPaused] = useState(false);
  const [invitesOpen, setInvitesOpen] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "codex") url.searchParams.set("v", "codex"); else url.searchParams.delete("v");
    window.history.replaceState({}, "", url.toString());
  }, [view]);
  const socketRef = useRef<RoomSocket | null>(null);
  const codexRef = useRef<CodexEntry[]>([]);
  useEffect(() => { codexRef.current = codex; }, [codex]);

  function markKindSeen(kind: CodexKind) {
    setLastSeenByKind((m) => ({ ...m, [kind]: Date.now() }));
  }
  function toggleSound() {
    setSoundOnState((on) => {
      const next = !on;
      setSoundEnabled(next);
      return next;
    });
  }

  useEffect(() => {
    if (!campaignId) return;
    const sock = new RoomSocket(campaignId);
    socketRef.current = sock;
    sock.onMessage((msg: ServerToClient) => {
      switch (msg.type) {
        case "snapshot":
          setCodex(msg.codex);
          setMode(msg.mode);
          setParticipants(msg.participants);
          setPersistence(msg.persistence);
          setAiPaused(!!msg.aiPaused);
          if (!msg.persistence.storage && !msg.persistence.db) {
            console.warn("[ai-dm] EPHEMERAL ROOM — codex changes will be lost on worker restart.");
          } else {
            console.log(`[ai-dm] PERSISTED to: ${[msg.persistence.db && "Postgres", msg.persistence.storage && "DO storage"].filter(Boolean).join(", ")}`);
          }
          break;
        case "participants": setParticipants(msg.participants); break;
        case "chat":
          setChat((c) => (c.some((m) => m.id === msg.message.id) ? c : [...c, msg.message]));
          break;
        case "codex.upsert": {
          const prev = codexRef.current.find((e) => e.id === msg.entry.id);
          const change = computeChange(prev, msg.entry, Date.now());
          setCodexChanges((m) => ({ ...m, [msg.entry.id]: change }));
          setCodex((c) => {
            const i = c.findIndex((e) => e.id === msg.entry.id);
            if (i >= 0) { const next = [...c]; next[i] = msg.entry; return next; }
            return [...c, msg.entry];
          });
          if (getSoundEnabled()) beep(prev ? "update" : "new");
          break;
        }
        case "codex.delete":
          setCodex((c) => c.filter((e) => e.id !== msg.id));
          if (getSoundEnabled()) beep("delete");
          break;
        case "codex.hide":
          setCodex((c) => c.filter((e) => e.id !== msg.id));
          setCodexChanges((m) => { const n = { ...m }; delete n[msg.id]; return n; });
          break;
        case "ai.paused":
          setAiPaused(msg.paused);
          break;
        case "mode.set": setMode(msg.mode); break;
        case "dm.status":
          setDmStatus(msg.state);
          if (msg.state === "thinking") {
            setDmPartial({});
            setBuildLog([]);
          }
          break;
        case "dm.partial":
          setDmPartial((cur) => ({ ...cur, ...msg.partial }));
          if (msg.partial.toolUse) {
            setBuildLog((prev) => [...prev, msg.partial.toolUse!].slice(-25));
          }
          break;
      }
    });
    sock.connect({ type: "hello", campaignId, displayName, role, token });
    return () => {
      sock.close();
      if (socketRef.current === sock) socketRef.current = null;
    };
  }, [campaignId, displayName, role, token]);

  const sock = socketRef.current;
  const modeLabel = useMemo(() => (mode === "worldbuilder" ? "WORLDBUILDER" : "PLAY SESSION"), [mode]);

  if (!campaignId) {
    return (
      <Lobby
        onEnter={(id, name, r, tok) => {
          setCampaignId(id);
          setDisplayName(name);
          setRole(r);
          setToken(tok ?? "");
        }}
        banner={BANNER}
      />
    );
  }

  const appClass = `app view-${view}`;

  const header = (
    <div className="panel header">
      <pre className="ascii" style={{ margin: 0, fontSize: 10, flexShrink: 0 }}>
        {`[${modeLabel}] room://${campaignId}`}
      </pre>
      <div className="nav-tabs">
        <button className={`nav-tab${view === "room" ? " active" : ""}`} onClick={() => setView("room")}>chat</button>
        <button className={`nav-tab${view === "codex" ? " active" : ""}`} onClick={() => setView("codex")}>codex</button>
      </div>
      <CodexTicker changes={codexChanges} />
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
        <PersistenceBadge info={persistence} />
        <button className="btn" onClick={toggleSound} title="toggle sound">{soundOn ? "♪ on" : "♪ off"}</button>
        {role === "dm" && token && (
          <button className="btn" onClick={() => setInvitesOpen(true)} title="manage co-DM invites">co-DMs</button>
        )}
        <button
          className="btn"
          style={aiPaused ? { color: "var(--danger)", borderColor: "var(--danger)" } : {}}
          onClick={() => sock?.send({ type: "ai.pause", paused: !aiPaused })}
          title={aiPaused ? "AI is silent on DM channel; click to resume" : "Click to silence the AI"}
        >
          AI {aiPaused ? "paused" : "ready"}
        </button>
        {mode === "play" && (
          <button
            className="btn"
            onClick={() => {
              if (confirm("Wrap up the session? The DM will write a session_note codex entry.")) {
                sock?.send({ type: "session.wrapup", reason: "manual" });
              }
            }}
          >
            wrap up session
          </button>
        )}
        <button className="btn" onClick={() => sock?.send({ type: "mode.set", mode: mode === "worldbuilder" ? "play" : "worldbuilder" })}>
          switch mode
        </button>
      </div>
    </div>
  );

  const inviteOverlay = role === "dm" && token ? (
    <InviteManager
      campaignId={campaignId}
      dmToken={token}
      participants={participants}
      open={invitesOpen}
      onClose={() => setInvitesOpen(false)}
    />
  ) : null;

  if (view === "codex") {
    return (
      <div className={appClass}>
        {header}
        {inviteOverlay}
        <div className="panel codex-page-wrap">
          <CodexPage
            entries={codex}
            changes={codexChanges}
            lastSeenByKind={lastSeenByKind}
            onMarkSeen={markKindSeen}
            onUpsert={(e) => sock?.send({ type: "codex.upsert", entry: e })}
            onDelete={(id) => sock?.send({ type: "codex.delete", id })}
            onAudit={() => sock?.send({ type: "codex.audit", reason: "manual" })}
            dmStatus={dmStatus}
            buildLog={buildLog}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={appClass}>
      {header}
      {inviteOverlay}

      <div className="panel codex">
        <div className="panel-header">codex</div>
        <div className="panel-body">
          <CodexPanel
            entries={codex}
            changes={codexChanges}
            lastSeenByKind={lastSeenByKind}
            onMarkSeen={markKindSeen}
            onUpsert={(e) => sock?.send({ type: "codex.upsert", entry: e })}
            onDelete={(id) => sock?.send({ type: "codex.delete", id })}
          />
        </div>
      </div>

      <div className="panel main">
        <div className="panel-header">dm channel — drafts for discord</div>
        <div className="panel-body">
          <DMChat
            messages={chat.filter((m) => m.channel === "dm")}
            onSend={(text, opts) => sock?.send({ type: "chat", channel: "dm", text, invokeAi: opts?.invokeAi, speakAsNpcId: opts?.speakAsNpcId })}
            dmStatus={dmStatus}
            dmPartial={dmPartial}
            buildLog={buildLog}
            myRole={role}
            myParticipantId={token}
            participants={participants}
            npcs={codex.filter((e) => e.kind === "npc")}
            aiPaused={aiPaused}
          />
        </div>
      </div>
    </div>
  );
}
