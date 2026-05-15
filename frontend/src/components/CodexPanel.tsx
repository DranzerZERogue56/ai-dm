import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexEntry, CodexKind } from "@ai-dm/shared";
import {
  BADGE_MS,
  FLASH_MS,
  diffLines,
  relativeTime,
  type CodexChangeMap,
} from "../lib/codex-changes";

const KINDS: CodexKind[] = [
  "timeline","town","npc","faction","quest","pc","location","item","lore","session_note","map","calendar","journal","house_rule",
];

interface Props {
  entries: CodexEntry[];
  changes: CodexChangeMap;
  lastSeenByKind: Record<string, number>;
  onMarkSeen: (kind: CodexKind) => void;
  onUpsert: (e: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string }) => void;
  onDelete: (id: string) => void;
}

export function CodexPanel({ entries, changes, lastSeenByKind, onMarkSeen, onUpsert, onDelete }: Props) {
  const [kind, setKind] = useState<CodexKind>("npc");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [now, setNow] = useState(Date.now());
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  // Periodic clock so flash/badge/timestamp render correctly without external nudges.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Mark the current kind seen on mount + whenever kind changes.
  useEffect(() => { onMarkSeen(kind); }, [kind]);

  const grouped = useMemo(() => {
    const m = new Map<CodexKind, CodexEntry[]>();
    for (const k of KINDS) m.set(k, []);
    for (const e of entries) (m.get(e.kind) ?? m.set(e.kind, []).get(e.kind)!).push(e);
    return m;
  }, [entries]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const selectedChange = selected ? changes[selected.id] : null;

  // Auto-scroll to a newly-arrived entry of the current kind.
  const lastFlashedRef = useRef<string | null>(null);
  useEffect(() => {
    const recentForKind = Object.values(changes)
      .filter((c) => c.kind === kind && now - c.at < FLASH_MS)
      .sort((a, b) => b.at - a.at)[0];
    if (recentForKind && recentForKind.id !== lastFlashedRef.current) {
      lastFlashedRef.current = recentForKind.id;
      itemRefs.current.get(recentForKind.id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [changes, kind, now]);

  function unreadDot(k: CodexKind): boolean {
    const seenAt = lastSeenByKind[k] ?? 0;
    return Object.values(changes).some((c) => c.kind === k && c.at > seenAt && c.id);
  }

  return (
    <div>
      <select value={kind} onChange={(e) => setKind(e.target.value as CodexKind)}>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {unreadDot(k) ? "* " : ""}{k.replace("_", " ")} ({grouped.get(k)?.length ?? 0})
          </option>
        ))}
      </select>
      <ul className="codex-list">
        {(grouped.get(kind) ?? []).map((e) => {
          const ch = changes[e.id];
          const flashing = ch && now - ch.at < FLASH_MS;
          const badge = ch && now - ch.at < BADGE_MS ? ch.changeKind : null;
          return (
            <li
              key={e.id}
              ref={(el) => { if (el) itemRefs.current.set(e.id, el); else itemRefs.current.delete(e.id); }}
              className={`codex-item ${flashing ? `flash-${ch.changeKind}` : ""}`}
              onClick={() => { setSelectedId(e.id); setShowDiff(false); }}
            >
              <span>{"> "}{e.title}</span>
              {badge && <span className={`codex-badge codex-badge-${badge}`}>{badge}</span>}
            </li>
          );
        })}
      </ul>
      <button className="btn" style={{ marginTop: 8 }}
        onClick={() => onUpsert({ kind, title: "new entry", body: "" })}>+ new {kind}</button>

      {selected && (
        <div style={{ marginTop: 12, borderTop: "1px dashed var(--border)", paddingTop: 8 }}>
          <input value={selected.title} onChange={(e) => onUpsert({ ...selected, title: e.target.value })} />
          {selected.tags?.length ? (
            <div className="tag-row">
              {selected.tags.map((t) => <span key={t} className="tag-chip">{t}</span>)}
            </div>
          ) : null}
          <div className="codex-meta">
            updated {relativeTime(selected.updatedAt, now)}
            {selectedChange?.prevBody && (
              <button
                className="btn"
                style={{ fontSize: 10, padding: "0 4px", marginLeft: 8 }}
                onClick={() => setShowDiff((v) => !v)}
              >
                {showDiff ? "hide diff" : "show diff"}
              </button>
            )}
          </div>
          {showDiff && selectedChange?.prevBody ? (
            <pre className="codex-diff">
              {diffLines(selectedChange.prevBody, selected.body).map((l, i) => (
                <div key={i} className={`diff-line diff-${l.sign === "+" ? "add" : l.sign === "-" ? "del" : "ctx"}`}>
                  <span className="diff-sign">{l.sign}</span>{l.text}
                </div>
              ))}
            </pre>
          ) : (
            <textarea
              rows={8}
              value={selected.body}
              onChange={(e) => onUpsert({ ...selected, body: e.target.value })}
              style={{ marginTop: 4 }}
            />
          )}
          <button className="btn" style={{ marginTop: 4 }} onClick={() => { onDelete(selected.id); setSelectedId(null); }}>delete</button>
        </div>
      )}
    </div>
  );
}
