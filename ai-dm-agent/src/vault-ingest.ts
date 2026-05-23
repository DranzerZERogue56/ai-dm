// Vault → codex ingest. Parses .md files written by obsidian-vault.ts back
// into partial CodexEntry shapes, then diffs against the current in-memory
// codex to produce a list of changes the user explicitly made in Obsidian.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexEntry, CodexSection, CodexLink } from "@ai-dm/shared";
import { campaignDir, readManifest, sha256 } from "./obsidian-vault";

// Minimal YAML-frontmatter parser. We only need flat scalars + simple sequences
// (tags, aliases). Tolerant of quoted strings and inline arrays.
export interface ParsedFile {
  id?: string;
  kind?: string;
  visibility?: string;
  tags?: string[];
  ownerId?: string;
  body: string;            // text between H1 and first H2 (or end if no H2)
  sections: CodexSection[]; // each H2 + content, excluding the auto "Links" section
  // We don't parse Links back — round-tripping our auto-rendered links is fraught.
  // But we keep the inline tags parsed for safety: they're already in frontmatter.
  rawTitle?: string;
}

function parseFrontmatter(src: string): { fm: Record<string, any>; body: string } {
  if (!src.startsWith("---")) return { fm: {}, body: src };
  const close = src.indexOf("\n---", 3);
  if (close < 0) return { fm: {}, body: src };
  const fmRaw = src.slice(3, close).trim();
  const rest = src.slice(close + 4).replace(/^\n/, "");

  // Tiny YAML parser: handles `key: value`, `key: "value"`, `key: [a, b]`, and indented sequences
  //   tags:
  //     - foo
  //     - bar
  const fm: Record<string, any> = {};
  const lines = fmRaw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const inline = m[2];
    if (inline === "" || inline === undefined) {
      // Sequence on following indented lines
      const seq: any[] = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const val = lines[i].replace(/^\s*-\s+/, "").trim();
        seq.push(unquote(val));
        i++;
      }
      fm[key] = seq;
      continue;
    }
    if (inline.startsWith("[") && inline.endsWith("]")) {
      fm[key] = inline.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter((s) => s.length > 0);
    } else {
      fm[key] = unquote(inline.trim());
    }
    i++;
  }
  return { fm, body: rest };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return s;
}

/**
 * Parse one .md file. We're tolerant — return whatever we can.
 */
export function parseEntryFile(content: string): ParsedFile {
  const { fm, body: afterFm } = parseFrontmatter(content);

  // Strip our own boilerplate (the > [!info] callout) so it doesn't end up in body.
  // Also strip the trailing inline tag line if present.
  const lines = afterFm.split("\n");

  // Find the first H1 (the title); the body starts after it.
  let bodyStart = 0;
  let rawTitle: string | undefined;
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].match(/^#\s+(.+)$/);
    if (t) { rawTitle = t[1].trim(); bodyStart = k + 1; break; }
  }

  // Find sections (## H2). The "Links" section is auto-generated and not ingested.
  const sections: CodexSection[] = [];
  const bodyLines: string[] = [];
  let currentH2: { title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!currentH2) return;
    if (currentH2.title.toLowerCase() !== "links") {
      sections.push({ title: currentH2.title, body: currentH2.lines.join("\n").trim() });
    }
    currentH2 = null;
  };

  let stopped = false;
  for (let k = bodyStart; k < lines.length && !stopped; k++) {
    const ln = lines[k];
    const h2 = ln.match(/^##\s+(.+)$/);
    if (h2) {
      flush();
      // The auto-rendered "## Links" section terminates structured content.
      // Anything after it is auto-rendered (tags, sentinels, custom user trailers)
      // that should NOT be ingested as part of any section.
      if (h2[1].trim().toLowerCase() === "links") { stopped = true; break; }
      currentH2 = { title: h2[1].trim(), lines: [] };
      continue;
    }
    // Skip our boilerplate callout block.
    if (ln.startsWith("> [!") || ln.startsWith("> _Source of truth")) continue;
    // Skip a hashtag-only line (auto-rendered inline-tags line).
    if (/^\s*(#[\w-]+\s*)+$/.test(ln)) continue;
    // Skip a bare image embed at root level — it's auto-rendered.
    if (!currentH2 && /^\s*!\[.+\]\(.+\)\s*$/.test(ln)) continue;
    if (currentH2) currentH2.lines.push(ln);
    else bodyLines.push(ln);
  }
  flush();

  // Trim trailing inline-tags line off body
  while (bodyLines.length && /^(\s*#[\w-]+\s*)+$/.test(bodyLines[bodyLines.length - 1])) bodyLines.pop();
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
  while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();

  return {
    id: typeof fm.id === "string" ? fm.id : undefined,
    kind: typeof fm.kind === "string" ? fm.kind : undefined,
    visibility: typeof fm.visibility === "string" ? fm.visibility : undefined,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : undefined,
    ownerId: typeof fm.ownerId === "string" ? fm.ownerId : undefined,
    body: bodyLines.join("\n").trim(),
    sections,
    rawTitle,
  };
}

// ---- Diff a parsed file against an in-memory CodexEntry ----

export interface VaultChange {
  entryId: string;
  kind: string;
  title: string;
  fields: ("body" | "sections" | "tags" | "visibility" | "title")[];
  diffSummary: string;
  // The merged entry to upsert (only fields the user changed are overwritten;
  // others come from the current codex state).
  next: Partial<CodexEntry> & { kind: any; title: string; body: string };
}

export function diffParsedAgainstCodex(parsed: ParsedFile, current: CodexEntry): VaultChange | null {
  const fields: VaultChange["fields"] = [];
  const next: any = {
    id: current.id,
    kind: current.kind,
    title: current.title,
    body: current.body,
    sections: current.sections,
    tags: current.tags,
    links: current.links,
    visibility: current.visibility,
    ownerId: current.ownerId,
    data: current.data,
    imageUrl: current.imageUrl,
  };

  if (parsed.rawTitle && parsed.rawTitle !== current.title) {
    fields.push("title");
    next.title = parsed.rawTitle;
  }
  if (parsed.body !== (current.body ?? "")) {
    fields.push("body");
    next.body = parsed.body;
  }

  // Compare sections by title+body order
  const curSec = (current.sections ?? []).map((s) => `${s.title}\n${s.body}`).join("\n---\n");
  const newSec = parsed.sections.map((s) => `${s.title}\n${s.body}`).join("\n---\n");
  if (curSec !== newSec) {
    fields.push("sections");
    next.sections = parsed.sections.length ? parsed.sections : undefined;
  }

  // Tags (order-insensitive)
  const a = new Set(current.tags ?? []);
  const b = new Set(parsed.tags ?? []);
  if (a.size !== b.size || [...a].some((t) => !b.has(t))) {
    fields.push("tags");
    next.tags = parsed.tags && parsed.tags.length ? parsed.tags : undefined;
  }

  if (parsed.visibility && parsed.visibility !== current.visibility) {
    fields.push("visibility");
    next.visibility = parsed.visibility;
  }

  if (!fields.length) return null;

  const summary = fields.map((f) => {
    if (f === "body") return `body (${current.body?.length ?? 0} → ${parsed.body.length} chars)`;
    if (f === "sections") return `sections (${current.sections?.length ?? 0} → ${parsed.sections.length})`;
    if (f === "tags") return `tags (${(current.tags ?? []).length} → ${(parsed.tags ?? []).length})`;
    if (f === "visibility") return `visibility (${current.visibility} → ${parsed.visibility})`;
    if (f === "title") return `title`;
    return f;
  }).join(", ");

  return { entryId: current.id, kind: current.kind, title: next.title, fields, diffSummary: summary, next };
}

// ---- Walk the campaign folder and produce a list of changes ----

async function* walkMd(root: string): AsyncGenerator<string> {
  let entries: any[];
  try { entries = await readdir(root, { withFileTypes: true } as any); }
  catch { return; }
  for (const e of entries) {
    const fp = join(root, e.name);
    if (e.isDirectory()) yield* walkMd(fp);
    else if (e.isFile() && fp.endsWith(".md") && !e.name.startsWith("_Index")) yield fp;
  }
}

export interface ScanResult {
  changes: VaultChange[];
  scannedFiles: number;
  vaultRoot: string;
}

export async function scanVault(vault: string, campaignId: string, codex: CodexEntry[]): Promise<ScanResult> {
  const root = campaignDir(vault, campaignId);
  const manifest = await readManifest(vault, campaignId);
  const lastHash = new Map<string, string>();
  if (manifest) for (const f of manifest.files) lastHash.set(f.path, f.hash);

  const byId = new Map(codex.map((e) => [e.id, e]));
  const changes: VaultChange[] = [];
  let scannedFiles = 0;

  for await (const fp of walkMd(root)) {
    scannedFiles++;
    const relPath = fp.startsWith(root) ? fp.slice(root.length + 1) : fp;
    const content = await readFile(fp, "utf8");
    const curHash = sha256(content);
    const prevHash = lastHash.get(relPath);
    // Unchanged since we last wrote this file → skip.
    if (prevHash && prevHash === curHash) continue;
    // First time seeing this file (no manifest entry) — could be a new entry, but we
    // only ingest known ids for now. (Phase C — create-on-new-file — is deferred.)
    if (!prevHash) continue;

    const parsed = parseEntryFile(content);
    if (!parsed.id) continue;
    const current = byId.get(parsed.id);
    if (!current) continue;
    const change = diffParsedAgainstCodex(parsed, current);
    if (change) changes.push(change);
  }

  return { changes, scannedFiles, vaultRoot: root };
}
