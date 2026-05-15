import { useEffect, useRef, useState } from "react";
import type { ChatMessage, CodexEntry, DmPartial, DmStatus, Participant } from "@ai-dm/shared";

interface SendOptions {
  invokeAi?: boolean;
  speakAsNpcId?: string;
}

interface Props {
  messages: ChatMessage[];
  onSend: (text: string, opts?: SendOptions) => void;
  dmStatus: DmStatus;
  dmPartial: DmPartial;
  buildLog?: { name: string; preview?: string }[];
  myRole?: "dm" | "player" | "agent";
  myParticipantId?: string;
  participants?: Participant[];
  npcs?: CodexEntry[];
  aiPaused?: boolean;
}

export function DMChat({ messages, onSend, dmStatus, dmPartial, buildLog = [], myRole, npcs = [], aiPaused = false }: Props) {
  const [text, setText] = useState("");
  const [speakAs, setSpeakAs] = useState<string>("");
  const [invokeAi, setInvokeAi] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [messages.length, dmStatus, dmPartial.thinking, dmPartial.text]);

  const isDM = myRole === "dm";

  function submit() {
    if (!text.trim()) return;
    onSend(text, {
      invokeAi: isDM ? invokeAi : undefined,
      speakAsNpcId: isDM && speakAs ? speakAs : undefined,
    });
    setText("");
    setInvokeAi(false);
  }

  function copyForDiscord(m: ChatMessage) {
    let body = m.text.trim();
    // If the AI spoke as an NPC, prefix with the NPC's name in bold for Discord.
    if (m.speakAsNpcId && m.speakAsNpcName) body = `**${m.speakAsNpcName}:** ${body}`;
    navigator.clipboard.writeText(body).then(() => {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1200);
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={ref} style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
        {messages.map((m) => (
          <div key={m.id} className={`chat-line ${m.authorRole}${m.speakAsNpcId ? " npc-voice" : ""}`}>
            {m.speakAsNpcId ? (
              <>
                <span style={{ color: "var(--phosphor-dim)" }}>[{m.speakAsNpcName ?? m.speakAsNpcId}]</span> {m.text}
              </>
            ) : (
              <>
                <span style={{ color: "var(--phosphor-dim)" }}>[{m.authorName}]</span> {m.text}
              </>
            )}
            {(m.authorRole === "agent" || m.speakAsNpcId) && (
              <button
                className="chat-copy"
                title="copy for Discord"
                onClick={() => copyForDiscord(m)}
              >
                {copiedId === m.id ? "✓ copied" : "📋 copy"}
              </button>
            )}
          </div>
        ))}
        {dmStatus === "thinking" && <Deliberation partial={dmPartial} buildLog={buildLog} />}
      </div>

      <form
        onSubmit={(ev) => { ev.preventDefault(); submit(); }}
        style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}
      >
        <span style={{ color: speakAs ? "var(--phosphor)" : invokeAi ? "var(--phosphor)" : "var(--phosphor-dim)" }}>
          {invokeAi ? "🤖" : speakAs ? "🎭" : pasteMode ? "📥" : ">"}
        </span>
        {isDM && npcs.length > 0 && (
          <select
            className="chat-whisper-select"
            value={speakAs}
            onChange={(e) => setSpeakAs(e.target.value)}
            title="speak as NPC (output is prefixed in copy)"
          >
            <option value="">as DM</option>
            {npcs.slice(0, 50).map((n) => <option key={n.id} value={n.id}>as {n.title}</option>)}
          </select>
        )}
        {pasteMode ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="paste a block of Discord messages here; submit sends them all to the DM channel"
            rows={4}
            style={{ flex: 1, fontFamily: "inherit" }}
          />
        ) : (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              invokeAi ? "ask the AI to narrate (or prefix with @dm)…"
                : speakAs ? `voice ${npcs.find((n) => n.id === speakAs)?.title}…`
                : "type to the AI, or @dm to invoke"
            }
            disabled={dmStatus === "thinking"}
          />
        )}
        {isDM && (
          <button
            type="button"
            className="btn"
            style={invokeAi ? { color: "var(--bg)", background: "var(--phosphor)", borderColor: "var(--phosphor)" } : {}}
            onClick={() => setInvokeAi((v) => !v)}
            title={aiPaused ? "AI is globally paused; toggle off to invoke" : "Invoke AI on this message"}
            disabled={aiPaused}
          >
            🤖 {invokeAi ? "on" : "off"}
          </button>
        )}
        <button
          type="button"
          className="btn"
          style={pasteMode ? { color: "var(--bg)", background: "var(--amber)", borderColor: "var(--amber)" } : {}}
          onClick={() => setPasteMode((v) => !v)}
          title="paste a block of Discord messages from your players"
        >
          📥 {pasteMode ? "single" : "paste"}
        </button>
      </form>
    </div>
  );
}

function Deliberation({ partial, buildLog }: { partial: DmPartial; buildLog: { name: string; preview?: string }[] }) {
  const thinking = (partial.thinking ?? "").trim();
  const text = (partial.text ?? "").trim();
  return (
    <div className="dm-deliberation">
      <div className="dm-deliberation-header">
        <span className="spinner">▌</span> DM is deliberating
        <span className="dots"><span>.</span><span>.</span><span>.</span></span>
      </div>
      {buildLog.length > 0 && <BuildingBlock buildLog={buildLog} />}
      {thinking && (
        <div className="dm-deliberation-section">
          <div className="dm-deliberation-label">thinking</div>
          <pre className="dm-deliberation-body">{thinking}<span className="caret">▌</span></pre>
        </div>
      )}
      {text && (
        <div className="dm-deliberation-section">
          <div className="dm-deliberation-label">drafting</div>
          <pre className="dm-deliberation-body">{text}<span className="caret">▌</span></pre>
        </div>
      )}
    </div>
  );
}

export function BuildingBlock({ buildLog }: { buildLog: { name: string; preview?: string }[] }) {
  const recent = buildLog.slice(-5);
  return (
    <div className="dm-building">
      <div className="dm-building-header">
        <span className="dm-building-icon">⚒</span>
        {" BUILDING: "}
        <span className="dm-building-count">{buildLog.length}</span>
        {" item" + (buildLog.length === 1 ? "" : "s")}
      </div>
      <ul className="dm-building-list">
        {recent.map((t, i) => (
          <li key={buildLog.length - recent.length + i}>
            <span className="dm-building-tool">{t.name}</span>
            {t.preview && <span className="dm-building-preview"> · {t.preview}</span>}
          </li>
        ))}
        {buildLog.length > recent.length && (
          <li className="dm-building-more">… +{buildLog.length - recent.length} earlier</li>
        )}
      </ul>
    </div>
  );
}
