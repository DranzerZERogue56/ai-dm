import { useEffect, useState } from "react";
import { recentForTicker, type CodexChangeMap } from "../lib/codex-changes";

export function CodexTicker({ changes }: { changes: CodexChangeMap }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const recent = recentForTicker(changes, now);
  if (recent.length === 0) {
    return <div className="codex-ticker codex-ticker-empty" aria-hidden />;
  }

  return (
    <div className="codex-ticker" aria-live="polite">
      <div className="codex-ticker-track">
        {recent.map((c) => {
          const ageMs = now - c.at;
          // Fade the oldest items toward the end of the window.
          const opacity = Math.max(0.35, 1 - ageMs / 30_000);
          return (
            <span key={`${c.id}-${c.at}`} className={`codex-ticker-item ${c.changeKind}`} style={{ opacity }}>
              <span className="codex-ticker-sign">{c.changeKind === "new" ? "+" : "~"}</span>
              <span className="codex-ticker-kind">{c.kind.replace("_", " ")}</span>
              <span className="codex-ticker-sep">:</span>
              <span className="codex-ticker-title">{c.title}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
