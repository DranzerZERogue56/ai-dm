import { useEffect, useState } from "react";
import type { VaultChange } from "@ai-dm/shared";

type Phase = "scanning" | "diff" | "applying" | "error";

interface Props {
  phase: Phase;
  changes: VaultChange[];
  scannedFiles?: number;
  error?: string;
  onApply: (accepted: VaultChange[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}

export function VaultDiffModal({ phase, changes, scannedFiles, error, onApply, onSkip, onCancel }: Props) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  useEffect(() => {
    setAccepted(new Set(changes.map((c) => c.entryId)));
  }, [changes]);

  function toggle(id: string) {
    setAccepted((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  return (
    <div className="invite-overlay" onClick={onCancel}>
      <div className="invite-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="invite-panel-header">
          <span>VAULT SYNC GATE</span>
          {phase === "diff" && <button className="btn" onClick={onCancel}>cancel</button>}
        </div>

        {phase === "scanning" && (
          <div style={{ color: "var(--phosphor-dim)", padding: 16 }}>
            <span className="caret">▌</span> scanning the vault for your changes…
          </div>
        )}

        {phase === "error" && (
          <>
            <div className="invite-error">scan failed: {error ?? "unknown error"}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="btn" onClick={onSkip}>send anyway</button>
              <button className="btn" onClick={onCancel}>cancel</button>
            </div>
          </>
        )}

        {phase === "applying" && (
          <div style={{ color: "var(--phosphor-dim)", padding: 16 }}>
            <span className="caret">▌</span> applying {accepted.size} change{accepted.size === 1 ? "" : "s"} and sending your message…
          </div>
        )}

        {phase === "diff" && (
          <>
            <div style={{ color: "var(--phosphor-dim)", fontSize: 11, marginBottom: 8 }}>
              Scanned {scannedFiles ?? 0} files · {changes.length} change{changes.length === 1 ? "" : "s"} detected since the last codex sync.
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: "50vh", overflowY: "auto" }}>
              {changes.map((c) => (
                <li key={c.entryId} className="vault-change-row">
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={accepted.has(c.entryId)}
                      onChange={() => toggle(c.entryId)}
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ color: "var(--phosphor)" }}>
                        <strong>{c.title}</strong>
                        <span style={{ color: "var(--phosphor-dim)", marginLeft: 8 }}>[{c.kind}]</span>
                      </div>
                      <div style={{ color: "var(--phosphor-dim)", fontSize: 11, marginTop: 2 }}>
                        {c.diffSummary}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button
                className="btn"
                disabled={accepted.size === 0}
                onClick={() => onApply(changes.filter((c) => accepted.has(c.entryId)))}
              >
                apply {accepted.size} change{accepted.size === 1 ? "" : "s"} &amp; send
              </button>
              <button className="btn" onClick={onSkip}>skip &amp; send anyway</button>
              <button className="btn" onClick={onCancel}>cancel</button>
            </div>
            <div style={{ color: "var(--phosphor-dim)", fontSize: 10, marginTop: 12, lineHeight: 1.5 }}>
              <strong style={{ color: "var(--amber)" }}>Note:</strong> skip preserves your vault edits for the next prompt. Cancel returns to typing without sending.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
