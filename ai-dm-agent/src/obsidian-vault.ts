// Obsidian vault writer. Renders a campaign's codex as one .md file per entry,
// organized by kind, with frontmatter + wikilinks. Vault is treated as a
// READ-ONLY mirror — anything in <vault>/AI-DM/<campaignId>/ may be overwritten.
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { CodexEntry, CodexKind } from "@ai-dm/shared";

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const KIND_DIR: Record<CodexKind, string> = {
  npc: "Npcs",
  pc: "Player Characters",
  faction: "Factions",
  town: "Towns",
  location: "Locations",
  lore: "Lore",
  quest: "Quests",
  item: "Items",
  timeline: "Timeline",
  calendar: "Calendar",
  map: "Maps",
  session_note: "Session Notes",
  journal: "Journals",
  house_rule: "House Rules",
};

const KIND_ORDER: CodexKind[] = [
  "house_rule", "lore", "timeline", "calendar", "faction", "town", "location",
  "npc", "pc", "quest", "item", "map", "session_note", "journal",
];

function safeFilename(s: string): string {
  // Strip filesystem-hostile chars; keep readable.
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 200);
}
function humanKind(k: CodexKind): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderFrontmatter(e: CodexEntry, campaignId: string): string {
  const fm: string[] = ["---"];
  fm.push(`id: ${e.id}`);
  fm.push(`kind: ${e.kind}`);
  fm.push(`campaign: ${campaignId}`);
  fm.push(`visibility: ${e.visibility}`);
  if (e.ownerId) fm.push(`ownerId: ${e.ownerId}`);
  fm.push(`updated: ${e.updatedAt}`);
  if (e.tags?.length) {
    fm.push("tags:");
    for (const t of e.tags) fm.push(`  - ${t}`);
  }
  // Obsidian alias lets [[id]] resolve to the same file as [[title]].
  fm.push("aliases:");
  fm.push(`  - "${e.title.replace(/"/g, '\\"')}"`);
  fm.push(`  - ${e.id}`);
  fm.push("ai-dm-mirror: true");
  fm.push("---");
  return fm.join("\n");
}

function renderEntry(e: CodexEntry, titleById: Map<string, string>): string {
  const lines: string[] = [];
  lines.push(renderFrontmatter(e, e.campaignId));
  lines.push("");
  lines.push(`# ${e.title}`);
  lines.push("");
  lines.push(`> [!info] ${humanKind(e.kind)} · visibility: \`${e.visibility}\``);
  lines.push("> _Source of truth: the AI-DM codex. Edits here will be overwritten on the next sync._");
  lines.push("");

  if (e.body?.trim()) {
    lines.push(e.body.trim());
    lines.push("");
  }

  if (e.sections?.length) {
    for (const s of e.sections) {
      lines.push(`## ${s.title}`);
      lines.push("");
      lines.push(s.body.trim() || "_(empty)_");
      lines.push("");
    }
  }

  if (e.imageUrl) {
    lines.push(`![${e.title}](${e.imageUrl})`);
    lines.push("");
  }

  if (e.links?.length) {
    lines.push("## Links");
    lines.push("");
    for (const l of e.links) {
      const targetTitle = titleById.get(l.targetId);
      if (targetTitle) {
        lines.push(`- **${l.relation}** → [[${safeFilename(targetTitle)}|${targetTitle}]]${l.note ? ` — ${l.note}` : ""}`);
      } else {
        lines.push(`- **${l.relation}** → ~~missing: ${l.targetId}~~${l.note ? ` — ${l.note}` : ""}`);
      }
    }
    lines.push("");
  }

  if (e.tags?.length) {
    // Obsidian inline tags. Already in frontmatter, but inline tags help with graph view.
    lines.push((e.tags ?? []).map((t) => `#${t}`).join(" "));
    lines.push("");
  }

  // Backlinks placeholder — Obsidian generates these automatically from incoming wikilinks.
  // No need to render them.

  return lines.join("\n").trimEnd() + "\n";
}

function renderIndex(codex: CodexEntry[], campaignId: string, campaignName?: string): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`campaign: ${campaignId}`);
  lines.push("ai-dm-mirror: true");
  lines.push("---");
  lines.push("");
  lines.push(`# ${campaignName ?? campaignId} — Index`);
  lines.push("");
  lines.push(`_${codex.length} entries · last synced: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("> [!warning] This vault is a one-way mirror from the AI-DM codex.");
  lines.push("> Don't edit notes here — your changes will be overwritten on the next sync.");
  lines.push("> Edit in the app (or via the AI-DM chat) and the changes flow into this vault.");
  lines.push("");

  const buckets = new Map<CodexKind, CodexEntry[]>();
  for (const k of KIND_ORDER) buckets.set(k, []);
  for (const e of codex) {
    if (!buckets.has(e.kind)) buckets.set(e.kind, []);
    buckets.get(e.kind)!.push(e);
  }
  for (const kind of buckets.keys()) {
    const entries = buckets.get(kind)!;
    if (!entries.length) continue;
    lines.push(`## ${humanKind(kind)} (${entries.length})`);
    lines.push("");
    entries.sort((a, b) => a.title.localeCompare(b.title));
    for (const e of entries) {
      lines.push(`- [[${safeFilename(e.title)}|${e.title}]]${e.tags?.length ? ` — _${e.tags.slice(0, 4).join(", ")}_` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Manifest tracks every file we wrote and its content hash. The hash lets the
// vault scanner detect "user edited this file after we wrote it" without
// false positives from filesystem mtime noise.
export interface ManifestFile {
  // relative path within <vault>/AI-DM/<campaignId>/
  path: string;
  // entry id (from the rendered frontmatter); null for _Index.md
  entryId: string | null;
  // SHA256 of the file content we wrote
  hash: string;
}
export interface Manifest {
  files: ManifestFile[];
  updated: string;
}

export function campaignDir(vault: string, campaignId: string): string {
  return join(vault, "AI-DM", campaignId);
}
function manifestPath(vault: string, campaignId: string): string {
  return join(campaignDir(vault, campaignId), ".ai-dm-manifest.json");
}

export async function readManifest(vault: string, campaignId: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(manifestPath(vault, campaignId), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch { return null; }
}

export async function writeVault(vault: string, campaignId: string, codex: CodexEntry[], campaignName?: string): Promise<void> {
  const root = campaignDir(vault, campaignId);
  await mkdir(root, { recursive: true });

  const prev = await readManifest(vault, campaignId);
  // Look up: relPath → previously-written hash (what we last knew the file as)
  const prevHashByPath = new Map<string, string>();
  if (prev) for (const f of prev.files) prevHashByPath.set(f.path, f.hash);

  const titleById = new Map(codex.map((e) => [e.id, e.title]));
  const writtenFiles: ManifestFile[] = [];
  let skippedDueToUserEdits = 0;

  for (const e of codex) {
    const kindDir = KIND_DIR[e.kind] ?? humanKind(e.kind);
    const relPath = join(kindDir, `${safeFilename(e.title)}.md`);
    const fp = join(root, relPath);
    await mkdir(dirname(fp), { recursive: true });
    const newContent = renderEntry(e, titleById);
    const newHash = sha256(newContent);

    // If this file exists and the user has edited it since we last wrote it,
    // don't overwrite — preserve the user's vault edits until the gate ingests them.
    let onDiskHash: string | null = null;
    try { onDiskHash = sha256(await readFile(fp, "utf8")); } catch { onDiskHash = null; }
    const lastKnownHash = prevHashByPath.get(relPath);
    const userEdited = !!(onDiskHash && lastKnownHash && onDiskHash !== lastKnownHash);

    if (userEdited) {
      // Edge case: empty file on disk almost certainly = a bad cleanup, not a
      // genuine "the user emptied this note." Treat as our content (write fresh).
      const onDiskContent = onDiskHash ? await readFile(fp, "utf8").catch(() => "") : "";
      if (onDiskContent.trim().length === 0) {
        await writeFile(fp, newContent, "utf8");
        writtenFiles.push({ path: relPath, entryId: e.id, hash: newHash });
        continue;
      }
      // Keep the user's content on disk; KEEP the last-known hash in the manifest
      // so the vault scanner can still detect this file as diverged (hash on
      // disk ≠ manifest hash) until the user ingests via the gate.
      writtenFiles.push({ path: relPath, entryId: e.id, hash: lastKnownHash! });
      skippedDueToUserEdits++;
      continue;
    }
    // Only write if content actually changed (avoids gratuitous mtime churn).
    if (onDiskHash === newHash) {
      writtenFiles.push({ path: relPath, entryId: e.id, hash: newHash });
      continue;
    }
    await writeFile(fp, newContent, "utf8");
    writtenFiles.push({ path: relPath, entryId: e.id, hash: newHash });
  }

  // Index page is always ours — overwrite freely.
  const indexContent = renderIndex(codex, campaignId, campaignName);
  await writeFile(join(root, "_Index.md"), indexContent, "utf8");
  writtenFiles.push({ path: "_Index.md", entryId: null, hash: sha256(indexContent) });

  // Sweep: delete files that existed last sync but aren't in the new set
  // AND were not user-edited (manifest hash still matches on-disk).
  if (prev) {
    const nowPaths = new Set(writtenFiles.map((f) => f.path));
    for (const f of prev.files) {
      if (nowPaths.has(f.path)) continue;
      const fp = join(root, f.path);
      let onDiskHash: string | null = null;
      try { onDiskHash = sha256(await readFile(fp, "utf8")); } catch { continue; }
      if (onDiskHash === f.hash) {
        // Untouched by user → safe to delete (the entry was deleted/renamed).
        try { await rm(fp, { force: true }); } catch {}
      }
      // Else: user edited a since-deleted-from-codex file. Leave it alone.
    }
  }

  const manifest: Manifest = { files: writtenFiles, updated: new Date().toISOString() };
  await writeFile(manifestPath(vault, campaignId), JSON.stringify(manifest, null, 2), "utf8");
  if (skippedDueToUserEdits > 0) {
    console.log(`[obsidian-vault] preserved ${skippedDueToUserEdits} user-edited file(s); use the vault gate to ingest them`);
  }
}

// Coalesce rapid bursts.
const pending = new Map<string, NodeJS.Timeout>();
const COALESCE_MS = 600;
export function scheduleVaultWrite(vault: string, campaignId: string, codex: CodexEntry[], campaignName?: string) {
  const key = `${vault}|${campaignId}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pending.delete(key);
    writeVault(vault, campaignId, codex, campaignName).catch((e) => {
      console.error(`[obsidian-vault] write failed for ${campaignId}:`, e);
    });
  }, COALESCE_MS);
  pending.set(key, t);
}

export function vaultRootFor(campaignId: string): string | null {
  const v = process.env.OBSIDIAN_VAULT;
  if (!v) return null;
  return campaignDir(v, campaignId);
}
