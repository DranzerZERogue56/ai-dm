import { useEffect, useMemo, useRef, useState } from "react";
import type { CodexEntry, CodexKind, CodexLink, CodexSection, DmStatus } from "@ai-dm/shared";
import { BADGE_MS, FLASH_MS, diffLines, relativeTime, type CodexChangeMap } from "../lib/codex-changes";

const KINDS: CodexKind[] = [
  "npc","pc","town","location","faction","quest","item","lore","house_rule","timeline","calendar","session_note","map","journal",
];

const SPIN_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

interface Props {
  entries: CodexEntry[];
  changes: CodexChangeMap;
  lastSeenByKind: Record<string, number>;
  onMarkSeen: (k: CodexKind) => void;
  onUpsert: (e: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string }) => void;
  onDelete: (id: string) => void;
  onAudit?: () => void;
  dmStatus?: DmStatus;
  buildLog?: { name: string; preview?: string }[];
}

export function CodexPage({ entries, changes, lastSeenByKind, onMarkSeen, onUpsert, onDelete, onAudit, dmStatus, buildLog = [] }: Props) {
  const [kind, setKind] = useState<CodexKind>("npc");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CodexEntry | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [now, setNow] = useState(Date.now());
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Audit feedback: "running" while waiting, "done" briefly after, null when idle.
  const [auditState, setAuditState] = useState<"running" | "done" | null>(null);
  const auditStartedAt = useRef<number>(0);
  // Currently-selected section tab index. For PC entries: 0 = Sheet, 1 = Overview, 2..N = sections.
  // For non-PC entries: 0 = Overview, 1..N = sections.
  const [activeTab, setActiveTab] = useState<number>(0);
  const [auditElapsed, setAuditElapsed] = useState<string>("");

  useEffect(() => {
    if (auditState !== "running") { setAuditElapsed(""); return; }
    const tick = () => {
      const s = Math.floor((Date.now() - auditStartedAt.current) / 1000);
      const m = Math.floor(s / 60);
      setAuditElapsed(`${m}:${String(s % 60).padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [auditState]);

  // Count codex changes that arrived during the current audit run.
  const auditChangeCount = useMemo(() => {
    if (auditState !== "running" && auditState !== "done") return 0;
    return Object.values(changes).filter((c) => c.at >= auditStartedAt.current).length;
  }, [changes, auditState]);

  // Watch dmStatus: once we're "running" and the DM flips to idle, audit is done.
  useEffect(() => {
    if (auditState !== "running" || dmStatus !== "idle") return;
    // Brief delay so any final stream events land in changes before we lock the count.
    const t = setTimeout(() => setAuditState("done"), 600);
    return () => clearTimeout(t);
  }, [dmStatus, auditState]);

  // Auto-clear the "done" badge after 4 seconds.
  useEffect(() => {
    if (auditState !== "done") return;
    const t = setTimeout(() => setAuditState(null), 4000);
    return () => clearTimeout(t);
  }, [auditState]);

  // Spinner frame ticker (CRT-style braille block rotation).
  const [spinFrame, setSpinFrame] = useState(0);
  useEffect(() => {
    if (auditState !== "running") return;
    const id = setInterval(() => setSpinFrame((n) => (n + 1) % SPIN_FRAMES.length), 120);
    return () => clearInterval(id);
  }, [auditState]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { onMarkSeen(kind); }, [kind]);

  const grouped = useMemo(() => {
    const m = new Map<CodexKind, CodexEntry[]>();
    for (const k of KINDS) m.set(k, []);
    for (const e of entries) (m.get(e.kind) ?? m.set(e.kind, []).get(e.kind)!).push(e);
    return m;
  }, [entries]);

  const visible = useMemo(() => {
    let list = grouped.get(kind) ?? [];
    if (tagFilter) list = list.filter((e) => e.tags?.includes(tagFilter));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q) || (e.tags ?? []).some((t) => t.includes(q)));
    }
    return list;
  }, [grouped, kind, query, tagFilter]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) for (const t of e.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const entriesById = useMemo(() => new Map(entries.map((e) => [e.id, e] as const)), [entries]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const selectedChange = selected ? changes[selected.id] : null;

  // Pull selected entry into a local draft so the editor doesn't fight incoming
  // updates while the user types. Only reset when the selected id changes.
  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
    setShowDiff(false);
    setActiveTab(0);
  }, [selectedId]);

  function unreadDot(k: CodexKind) {
    const seenAt = lastSeenByKind[k] ?? 0;
    return Object.values(changes).some((c) => c.kind === k && c.at > seenAt);
  }

  function commit() {
    if (!draft) return;
    onUpsert(draft);
  }

  function dataJson(): string {
    return draft?.data ? JSON.stringify(draft.data, null, 2) : "";
  }

  function setDataFromJson(text: string) {
    if (!draft) return;
    if (!text.trim()) { setDraft({ ...draft, data: undefined }); return; }
    try {
      const parsed = JSON.parse(text);
      setDraft({ ...draft, data: parsed });
    } catch {
      /* leave the raw text in the textarea; don't update draft.data until valid */
    }
  }

  return (
    <div className="codex-page">
      {dmStatus === "thinking" && (
        <div className="codex-building-badge" title="the AI is building/correcting codex items">
          <span className="codex-building-icon">⚒</span>
          {" BUILDING: "}
          <span className="codex-building-count">{buildLog.length}</span>
          {" item" + (buildLog.length === 1 ? "" : "s")}
          {buildLog.length > 0 && (
            <span className="codex-building-last"> — last: {buildLog[buildLog.length - 1].name}{buildLog[buildLog.length - 1].preview ? ` · ${buildLog[buildLog.length - 1].preview!.slice(0, 60)}` : ""}</span>
          )}
        </div>
      )}
      <nav className="codex-tabs">
        {KINDS.map((k) => {
          const count = grouped.get(k)?.length ?? 0;
          const active = k === kind;
          return (
            <button
              key={k}
              className={`codex-tab${active ? " active" : ""}`}
              onClick={() => setKind(k)}
            >
              {unreadDot(k) && <span className="codex-tab-dot" />}
              {k.replace("_", " ")} <span className="codex-tab-count">{count}</span>
            </button>
          );
        })}
        {onAudit && (
          <div className="codex-audit-wrap">
            <button
              className={`codex-tab codex-audit-btn${auditState === "running" ? " auditing" : ""}${auditState === "done" ? " audit-done" : ""}`}
              disabled={auditState === "running"}
              onClick={() => {
                if (auditState === "running") return;
                if (!confirm("Have the DM audit every codex entry against the chat history? Sonnet, full context — can take 1–5 minutes for a populated codex.")) return;
                auditStartedAt.current = Date.now();
                setAuditState("running");
                onAudit();
              }}
              title="audit every codex entry against actual chat history"
            >
              {auditState === "running" ? (
                <>
                  <span className="codex-audit-spinner">{SPIN_FRAMES[spinFrame]}</span>
                  {" auditing "}
                  <span className="codex-audit-count">{auditElapsed}</span>
                  {" · "}
                  <span className="codex-audit-count">{auditChangeCount} edit{auditChangeCount === 1 ? "" : "s"}</span>
                </>
              ) : auditState === "done" ? (
                <>✓ audit complete ({auditChangeCount} edit{auditChangeCount === 1 ? "" : "s"})</>
              ) : (
                "audit codex"
              )}
            </button>
            {auditState === "running" && (
              <button
                className="codex-tab codex-audit-cancel"
                onClick={() => {
                  if (confirm("Give up waiting on the audit? This only resets the spinner — the agent may still be running in the background.")) {
                    setAuditState(null);
                  }
                }}
                title="reset local spinner (does not stop the agent)"
              >cancel</button>
            )}
          </div>
        )}
      </nav>
      {allTags.length > 0 && (
        <div className="codex-tag-bar">
          <span className="codex-tag-bar-label">tags:</span>
          {tagFilter && (
            <button className="tag-chip tag-chip-active" onClick={() => setTagFilter(null)}>
              clear: {tagFilter} ×
            </button>
          )}
          {allTags.slice(0, 25).map(([t, n]) => (
            <button
              key={t}
              className={`tag-chip${tagFilter === t ? " tag-chip-active" : ""}`}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >
              {t} <span className="tag-chip-count">{n}</span>
            </button>
          ))}
        </div>
      )}

      <div className="codex-page-body">
        <aside className="codex-page-list">
          <div className="codex-page-toolbar">
            <input
              placeholder={`filter ${kind}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="btn"
              onClick={() => {
                const e: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string } = {
                  kind, title: `new ${kind}`, body: "",
                };
                onUpsert(e);
              }}
            >+ new</button>
          </div>
          <div className="codex-page-items">
            {visible.length === 0 && (
              <div className="codex-page-empty">_(no {kind} entries{query ? ` matching “${query}”` : ""})_</div>
            )}
            {visible.map((e) => {
              const ch = changes[e.id];
              const flashing = ch && now - ch.at < FLASH_MS;
              const badge = ch && now - ch.at < BADGE_MS ? ch.changeKind : null;
              const selectedHere = e.id === selectedId;
              return (
                <div
                  key={e.id}
                  ref={(el) => { if (el) itemRefs.current.set(e.id, el); else itemRefs.current.delete(e.id); }}
                  className={`codex-page-item${selectedHere ? " selected" : ""}${flashing ? ` flash-${ch.changeKind}` : ""}`}
                  onClick={() => setSelectedId(e.id)}
                >
                  <div className="codex-page-item-title">
                    {e.title}
                    {badge && <span className={`codex-badge codex-badge-${badge}`}>{badge}</span>}
                  </div>
                  <div className="codex-page-item-preview">
                    {e.body.split("\n")[0].slice(0, 120) || "(empty)"}
                  </div>
                  <div className="codex-page-item-meta">
                    {relativeTime(e.updatedAt, now)} · {e.visibility}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="codex-page-detail">
          {!draft ? (
            <div className="codex-page-empty">_(select an entry on the left, or create a new one)_</div>
          ) : (
            <>
              <div className="codex-page-detail-head">
                <input
                  className="codex-page-title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  onBlur={commit}
                />
                <div className="codex-page-detail-meta">
                  <span>id: <code>{draft.id}</code></span>
                  <span>kind: {draft.kind.replace("_", " ")}</span>
                  <span>updated: {relativeTime(draft.updatedAt, now)}</span>
                </div>
              </div>
              <div className="codex-page-detail-controls">
                <label>visibility:&nbsp;
                  <select
                    value={draft.visibility}
                    onChange={(e) => {
                      const v = e.target.value as CodexEntry["visibility"];
                      setDraft({ ...draft, visibility: v });
                      onUpsert({ ...draft, visibility: v });
                    }}
                  >
                    <option value="public">public</option>
                    <option value="dm">dm only</option>
                    <option value="player">player only</option>
                  </select>
                </label>
                {selectedChange?.prevBody && (
                  <button className="btn" onClick={() => setShowDiff((v) => !v)}>
                    {showDiff ? "hide diff" : "show diff vs last DM edit"}
                  </button>
                )}
                <button className="btn" onClick={commit}>save</button>
                <button
                  className="btn"
                  onClick={() => {
                    if (confirm(`Delete "${draft.title}"? This cannot be undone.`)) {
                      onDelete(draft.id);
                      setSelectedId(null);
                    }
                  }}
                >delete</button>
              </div>

              <div className="codex-page-tags-edit">
                <label>tags:&nbsp;
                  <input
                    placeholder="comma-separated (e.g. coastal, arc-1, smuggler)"
                    defaultValue={(draft.tags ?? []).join(", ")}
                    onBlur={(e) => {
                      const tags = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                      const next = { ...draft, tags: tags.length ? tags : undefined };
                      setDraft(next);
                      onUpsert(next);
                    }}
                  />
                </label>
              </div>

              <LinksEditor
                draft={draft}
                entries={entries}
                entriesById={entriesById}
                onChange={(links) => {
                  const next = { ...draft, links };
                  setDraft(next);
                  onUpsert(next);
                }}
              />
              <SectionTabs
                draft={draft}
                activeTab={activeTab}
                onActiveTabChange={setActiveTab}
                onChange={(next) => { setDraft(next); }}
                onCommit={(next) => { setDraft(next); onUpsert(next); }}
                showDiff={showDiff}
                prevBody={selectedChange?.prevBody}
              />
              <details className="codex-page-extra">
                <summary>extra data (json)</summary>
                <textarea
                  className="codex-page-json"
                  defaultValue={dataJson()}
                  onBlur={(e) => { setDataFromJson(e.target.value); commit(); }}
                  spellCheck={false}
                />
                <div className="codex-page-extra-meta">
                  image url:&nbsp;
                  <input
                    value={draft.imageUrl ?? ""}
                    onChange={(e) => setDraft({ ...draft, imageUrl: e.target.value })}
                    onBlur={commit}
                    placeholder="(none)"
                  />
                </div>
                {draft.imageUrl && <img className="codex-page-image" src={draft.imageUrl} alt={draft.title} />}
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const COMMON_RELATIONS = [
  "lives_in","member_of","rules","allied_with","enemy_of","located_in","owns","originates_from","appeared_in","related_to","child_of","parent_of",
];

function LinksEditor({
  draft,
  entries,
  entriesById,
  onChange,
}: {
  draft: CodexEntry;
  entries: CodexEntry[];
  entriesById: Map<string, CodexEntry>;
  onChange: (links: CodexLink[] | undefined) => void;
}) {
  const links = draft.links ?? [];
  function update(next: CodexLink[]) {
    onChange(next.length ? next : undefined);
  }
  function addBlank() {
    const target = entries.find((e) => e.id !== draft.id);
    if (!target) return;
    update([...links, { relation: "related_to", targetId: target.id }]);
  }
  return (
    <div className="codex-page-links">
      <div className="codex-page-links-head">
        <span>links ({links.length})</span>
        <button className="btn" onClick={addBlank} disabled={entries.length < 2}>+ add link</button>
      </div>
      {links.length === 0 && <div className="codex-page-empty" style={{ padding: "4px 0" }}>(no links — connect this to NPCs, locations, factions, or quests it belongs to)</div>}
      {links.map((l, i) => {
        const tgt = entriesById.get(l.targetId);
        return (
          <div key={i} className="codex-link-row">
            <input
              className="codex-link-relation"
              list="codex-relation-list"
              value={l.relation}
              onChange={(e) => {
                const next = [...links];
                next[i] = { ...next[i], relation: e.target.value };
                update(next);
              }}
            />
            <select
              className="codex-link-target"
              value={l.targetId}
              onChange={(e) => {
                const next = [...links];
                next[i] = { ...next[i], targetId: e.target.value };
                update(next);
              }}
            >
              {entries.filter((e) => e.id !== draft.id).map((e) => (
                <option key={e.id} value={e.id}>[{e.kind}] {e.title}</option>
              ))}
            </select>
            <input
              className="codex-link-note"
              placeholder="note (optional)"
              defaultValue={l.note ?? ""}
              onBlur={(e) => {
                const next = [...links];
                next[i] = { ...next[i], note: e.target.value || undefined };
                update(next);
              }}
            />
            <button className="btn" onClick={() => update(links.filter((_, j) => j !== i))} title="remove link">x</button>
            {!tgt && <span style={{ color: "var(--danger)", fontSize: 10 }}>missing target</span>}
          </div>
        );
      })}
      <datalist id="codex-relation-list">
        {COMMON_RELATIONS.map((r) => <option key={r} value={r} />)}
      </datalist>
    </div>
  );
}

function SectionTabs({
  draft,
  activeTab,
  onActiveTabChange,
  onChange,
  onCommit,
  showDiff,
  prevBody,
}: {
  draft: CodexEntry;
  activeTab: number;
  onActiveTabChange: (n: number) => void;
  onChange: (next: CodexEntry) => void;
  onCommit: (next: CodexEntry) => void;
  showDiff: boolean;
  prevBody?: string;
}) {
  const sections: CodexSection[] = draft.sections ?? [];
  const tabs: { title: string; isBody: boolean }[] = [
    { title: "Overview", isBody: true },
    ...sections.map((s) => ({ title: s.title || "untitled", isBody: false })),
  ];
  const clampedActive = Math.min(activeTab, tabs.length - 1);
  const isBody = clampedActive === 0;
  const sectionIdx = clampedActive - 1;

  function addSection() {
    const next = { ...draft, sections: [...sections, { title: `Tab ${sections.length + 1}`, body: "" }] };
    onCommit(next);
    onActiveTabChange(next.sections!.length); // jump to new tab
  }
  function renameSection(i: number, title: string) {
    const ns = [...sections];
    ns[i] = { ...ns[i], title };
    onCommit({ ...draft, sections: ns });
  }
  function deleteSection(i: number) {
    const ns = sections.filter((_, j) => j !== i);
    onCommit({ ...draft, sections: ns.length ? ns : undefined });
    onActiveTabChange(0);
  }
  function moveSection(i: number, delta: -1 | 1) {
    const j = i + delta;
    if (j < 0 || j >= sections.length) return;
    const ns = [...sections];
    [ns[i], ns[j]] = [ns[j], ns[i]];
    onCommit({ ...draft, sections: ns });
    onActiveTabChange(j + 1);
  }
  function setBody(text: string, commit: boolean) {
    if (isBody) {
      const next = { ...draft, body: text };
      commit ? onCommit(next) : onChange(next);
    } else {
      const ns = [...sections];
      ns[sectionIdx] = { ...ns[sectionIdx], body: text };
      const next = { ...draft, sections: ns };
      commit ? onCommit(next) : onChange(next);
    }
  }

  const currentBody = isBody ? draft.body : sections[sectionIdx]?.body ?? "";

  return (
    <div className="codex-tabs-wrap">
      <div className="codex-section-tabs">
        {tabs.map((t, i) => (
          <button
            key={i}
            className={`codex-section-tab${i === clampedActive ? " active" : ""}`}
            onClick={() => onActiveTabChange(i)}
          >
            {t.title}
          </button>
        ))}
        <button className="codex-section-tab codex-section-add" onClick={addSection} title="add tab">+</button>
      </div>

      {!isBody && (
        <div className="codex-section-controls">
          <label>tab name:&nbsp;
            <input
              value={sections[sectionIdx]?.title ?? ""}
              onChange={(e) => {
                const ns = [...sections];
                ns[sectionIdx] = { ...ns[sectionIdx], title: e.target.value };
                onChange({ ...draft, sections: ns });
              }}
              onBlur={(e) => renameSection(sectionIdx, e.target.value)}
            />
          </label>
          <button className="btn" onClick={() => moveSection(sectionIdx, -1)} disabled={sectionIdx === 0} title="move left">←</button>
          <button className="btn" onClick={() => moveSection(sectionIdx, +1)} disabled={sectionIdx === sections.length - 1} title="move right">→</button>
          <button
            className="btn"
            onClick={() => {
              if (confirm(`Delete tab "${sections[sectionIdx]?.title}"?`)) deleteSection(sectionIdx);
            }}
          >delete tab</button>
        </div>
      )}

      {showDiff && isBody && prevBody ? (
        <pre className="codex-diff codex-page-diff">
          {diffLines(prevBody, draft.body).map((l, i) => (
            <div key={i} className={`diff-line diff-${l.sign === "+" ? "add" : l.sign === "-" ? "del" : "ctx"}`}>
              <span className="diff-sign">{l.sign}</span>{l.text}
            </div>
          ))}
        </pre>
      ) : (
        <textarea
          className="codex-page-body-edit"
          value={currentBody}
          onChange={(e) => setBody(e.target.value, false)}
          onBlur={(e) => setBody(e.target.value, true)}
          spellCheck={false}
          placeholder={isBody ? "Overview (1-3 paragraphs). Long detail goes in tabs." : "Content for this tab…"}
        />
      )}
    </div>
  );
}
