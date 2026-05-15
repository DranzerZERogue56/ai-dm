import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CodexEntry, CodexKind } from "@ai-dm/shared";

const KIND_ORDER: CodexKind[] = [
  "house_rule","lore","timeline","calendar","faction","town","location",
  "npc","pc","quest","item","map","session_note","journal",
];

const HOME = process.env.AI_DM_HOME ?? join(homedir(), ".ai-dm");

export function mdPathFor(campaignId: string): string {
  return join(HOME, "campaigns", `${campaignId}.md`);
}

// Coalesce rapid bursts of upserts into a single write per campaign.
const pending = new Map<string, NodeJS.Timeout>();
const COALESCE_MS = 400;

export function scheduleMdWrite(campaignId: string, codex: CodexEntry[], campaignName?: string) {
  const existing = pending.get(campaignId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pending.delete(campaignId);
    void writeMd(campaignId, codex, campaignName);
  }, COALESCE_MS);
  pending.set(campaignId, t);
}

export async function writeMd(campaignId: string, codex: CodexEntry[], campaignName?: string) {
  const path = mdPathFor(campaignId);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderMd(campaignId, codex, campaignName), "utf8");
  } catch (e) {
    console.error(`[md-mirror] write failed for ${campaignId}:`, e);
  }
}

export function renderMd(campaignId: string, codex: CodexEntry[], campaignName?: string): string {
  const out: string[] = [];
  out.push(`# Campaign: ${campaignName ?? campaignId}`);
  out.push("");
  out.push(`_id: \`${campaignId}\`_ · _mirror updated: ${new Date().toISOString()}_ · _${codex.length} entries_`);
  out.push("");
  out.push("---");
  out.push("");
  if (codex.length === 0) {
    out.push("_(empty)_");
    return out.join("\n");
  }

  const buckets = new Map<CodexKind, CodexEntry[]>();
  for (const k of KIND_ORDER) buckets.set(k, []);
  for (const e of codex) {
    if (!buckets.has(e.kind)) buckets.set(e.kind, []);
    buckets.get(e.kind)!.push(e);
  }

  for (const kind of buckets.keys()) {
    const entries = buckets.get(kind)!;
    if (entries.length === 0) continue;
    out.push(`## ${humanKind(kind)} (${entries.length})`);
    out.push("");
    entries.sort((a, b) => a.title.localeCompare(b.title));
    for (const e of entries) {
      out.push(`### ${e.title}`);
      out.push("");
      out.push(`_id: \`${e.id}\`_ · _visibility: ${e.visibility}_ · _updated: ${e.updatedAt}_`);
      out.push("");
      out.push(e.body.trim() || "_(empty)_");
      if (e.imageUrl) {
        out.push("");
        out.push(`![${e.title}](${e.imageUrl})`);
      }
      out.push("");
    }
    out.push("---");
    out.push("");
  }
  return out.join("\n");
}

function humanKind(k: CodexKind): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Best-effort: if the .md exists already, read it. We don't parse it back —
// the DO is authoritative. This is purely so a manual export tool could use it.
export async function readMdIfExists(campaignId: string): Promise<string | null> {
  try {
    return await readFile(mdPathFor(campaignId), "utf8");
  } catch {
    return null;
  }
}
