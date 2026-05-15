import type { CodexEntry, CodexKind } from "@ai-dm/shared";

export interface CodexChange {
  id: string;
  kind: CodexKind;
  title: string;
  changeKind: "new" | "updated";
  at: number;
  prevBody?: string;
}

export type CodexChangeMap = Record<string, CodexChange>;

export const TICKER_WINDOW_MS = 30_000;
export const FLASH_MS = 1800;
export const BADGE_MS = 10_000;

export function recentForTicker(changes: CodexChangeMap, now: number, max = 6): CodexChange[] {
  return Object.values(changes)
    .filter((c) => now - c.at < TICKER_WINDOW_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const d = now - new Date(iso).getTime();
  if (d < 0) return "just now";
  const s = Math.floor(d / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export function diffLines(prev: string, next: string): { sign: " " | "+" | "-"; text: string }[] {
  // Minimal LCS-free diff: align by line index, mark removed/added; identical lines render unchanged.
  const a = prev.split("\n");
  const b = next.split("\n");
  const out: { sign: " " | "+" | "-"; text: string }[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const oldLine = a[i];
    const newLine = b[i];
    if (oldLine === newLine) {
      if (oldLine !== undefined) out.push({ sign: " ", text: oldLine });
    } else {
      if (oldLine !== undefined) out.push({ sign: "-", text: oldLine });
      if (newLine !== undefined) out.push({ sign: "+", text: newLine });
    }
  }
  return out;
}

export function computeChange(
  prev: CodexEntry | undefined,
  next: CodexEntry,
  now: number
): CodexChange {
  return {
    id: next.id,
    kind: next.kind,
    title: next.title,
    changeKind: prev ? "updated" : "new",
    at: now,
    prevBody: prev?.body,
  };
}
