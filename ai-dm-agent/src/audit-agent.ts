import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CodexEntry, CodexKind, CodexLink, CodexSection, DmPartial } from "@ai-dm/shared";

export interface AuditStreamCallbacks {
  onPartial?: (p: DmPartial) => void;
}

export interface AuditReply {
  narration?: string;
  codexUpserts?: (Partial<CodexEntry> & { kind: CodexKind; title: string; body: string })[];
  codexDeletes?: string[];
}

interface ChatEntry {
  author: string;
  text: string;
  channel: "dm" | "assistant";
  role: "dm" | "player" | "agent" | "system";
  createdAt?: string;
}

const CODEX_KINDS = [
  "timeline","town","npc","faction","quest","pc","location","item","lore","session_note","map","calendar","journal","house_rule",
] as const;

const AUDIT_MODEL = process.env.AUDIT_MODEL ?? process.env.DM_MODEL ?? "claude-sonnet-4-6";

const AUDIT_SYSTEM_PROMPT = `You are a CODEX AUDITOR for a collaborative D&D 5e campaign.

You DO NOT narrate, you DO NOT role-play, you DO NOT extend or invent lore. You compare every codex entry against the actual chat history of the campaign and fix three classes of problem:

1. HALLUCINATION: codex content the players never said and the DM made up. Trim it.
2. MISREPRESENTATION: codex content that twists what a player said. Rewrite it to match their words.
3. UNGROUNDED ELABORATION: plausible color the DM added that wasn't established. Either move it to a "**Possibilities (unconfirmed):**" subsection at the end of the body, OR remove it.

Source of truth:
- Player messages (role: "player" or "dm" — the human DM counts as a player author here) are GROUND TRUTH.
- AI-DM messages (role: "agent") are the AI's interpretation. Treat them as suspect — they may have hallucinated.
- Existing codex bodies are also suspect. The chat is the canonical record of what was actually agreed.

For every codex entry, in order:
1. Read the entry's title, body, and any existing sections (tabs).
2. Search the chat history (provided in full) for what players actually said about this thing.
3. If the body matches what was said → leave it alone.
4. If the body invents details → call codex_upsert with a trimmed body. Add tag "speculation" if you kept any unconfirmed parts in a "Possibilities" subsection or section.
5. If two or more entries refer to the same thing → call codex_merge to fold them into one. The tool deletes the sources and rewrites incoming links. NEVER leave duplicates.
6. If a connection is established in chat but missing from links → call codex_link to add it.
7. If an entry has lots of disparate content crammed into one body (backstory + stats + relationships in one blob), split it into sections via codex_upsert with a sections argument. One entry per named thing; many tabs within.
8. Always add tags if missing (3-6 kebab-case keywords reflecting role, region, theme, arc).

Quote the chat in your reasoning when you change something. Be conservative — when in doubt, leave the existing text and just add a "speculation" tag.

When you're done with all entries, reply with a short summary: how many entries you reviewed, how many you trimmed, how many you tagged as speculation, how many links you added. Bullet list, terse.`;

const linkSchema = z.object({
  relation: z.string().min(1),
  targetId: z.string().min(1),
  note: z.string().optional(),
});

const sectionSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

export async function runAuditTurn(args: {
  codex: CodexEntry[];
  chat: ChatEntry[];
  cb?: AuditStreamCallbacks;
}): Promise<AuditReply> {
  const { codex, chat, cb = {} } = args;
  const reply: AuditReply = {};
  const collectedUpserts: NonNullable<AuditReply["codexUpserts"]> = [];
  const collectedDeletes = new Set<string>();
  const startTs = Date.now();
  let upsertCalls = 0;
  let linkCalls = 0;
  let mergeCalls = 0;
  console.log(`[audit] START — ${codex.length} codex entries, ${chat.length} chat messages, model=${AUDIT_MODEL}`);

  const liveCodex = new Map<string, Partial<CodexEntry>>();
  for (const e of codex) liveCodex.set(e.id, { ...e });

  const codexServer = createSdkMcpServer({
    name: "audit",
    version: "0.1.0",
    tools: [
      tool(
        "codex_upsert",
        "Update an existing codex entry to better match what the players actually said. Almost always called with an existing id — creating new entries is rare during an audit. Use sections to organize big bodies into tabs.",
        {
          id: z.string().optional(),
          kind: z.enum(CODEX_KINDS),
          title: z.string().min(1),
          body: z.string().min(1),
          sections: z.array(sectionSchema).optional().describe("Tabs beyond the overview body — e.g. Backstory, Stats, Inventory, Relationships."),
          tags: z.array(z.string()).optional(),
          links: z.array(linkSchema).optional(),
          visibility: z.enum(["public", "dm", "player"]).optional(),
          rationale: z.string().min(1).describe("One sentence explaining what was wrong and citing the chat if possible. Required for audit traceability."),
        },
        async (a) => {
          const entry = {
            id: a.id,
            kind: a.kind,
            title: a.title,
            body: a.body,
            sections: a.sections,
            tags: a.tags,
            links: a.links,
            visibility: a.visibility ?? "public",
          };
          collectedUpserts.push(entry);
          upsertCalls++;
          console.log(`[audit] codex_upsert #${upsertCalls}: [${a.kind}] ${a.title} — ${a.rationale.slice(0, 100)}`);
          const known = a.id ?? `pending-${collectedUpserts.length}`;
          liveCodex.set(known, entry as Partial<CodexEntry>);
          cb.onPartial?.({ toolUse: { name: "codex_upsert", preview: `[${a.kind}] ${a.title} — ${a.rationale.slice(0, 80)}` } });
          return { content: [{ type: "text", text: `corrected ${a.kind}: ${a.title}` }] };
        }
      ),
      tool(
        "codex_get",
        "Read one codex entry's full body, sections, tags, and links by id.",
        { id: z.string().min(1) },
        async (a) => {
          const e = liveCodex.get(a.id);
          if (!e) return { content: [{ type: "text", text: `error: no entry with id ${a.id}` }], isError: true };
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                id: e.id, kind: e.kind, title: e.title, body: e.body,
                sections: e.sections ?? [], tags: e.tags ?? [], links: e.links ?? [],
                visibility: e.visibility ?? "public",
              }, null, 2),
            }],
          };
        }
      ),
      tool(
        "codex_search",
        "Find codex entry ids matching kind, tag, and/or title substring.",
        {
          kind: z.enum(CODEX_KINDS).optional(),
          tag: z.string().optional(),
          titleContains: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (a) => {
          const q = (a.titleContains ?? "").toLowerCase();
          const limit = a.limit ?? 50;
          const matches: { id: string; kind: string; title: string }[] = [];
          for (const e of liveCodex.values()) {
            if (a.kind && e.kind !== a.kind) continue;
            if (a.tag && !(e.tags ?? []).includes(a.tag)) continue;
            if (q && !(e.title ?? "").toLowerCase().includes(q)) continue;
            matches.push({ id: e.id!, kind: e.kind!, title: e.title! });
            if (matches.length >= limit) break;
          }
          return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
        }
      ),
      tool(
        "codex_delete",
        "Delete a single codex entry by id. Use when an entry references something never established in chat, OR when the player asks for removal.",
        {
          id: z.string().min(1),
          rationale: z.string().min(1).describe("Why deleting (cite chat if possible)."),
        },
        async (a) => {
          if (!liveCodex.has(a.id)) return { content: [{ type: "text", text: `error: no entry with id ${a.id}` }], isError: true };
          const e = liveCodex.get(a.id)!;
          collectedDeletes.add(a.id);
          liveCodex.delete(a.id);
          console.log(`[audit] codex_delete: ${e.title} — ${a.rationale.slice(0, 100)}`);
          cb.onPartial?.({ toolUse: { name: "codex_delete", preview: `${e.title} — ${a.rationale.slice(0, 80)}` } });
          return { content: [{ type: "text", text: `deleted ${e.title}` }] };
        }
      ),
      tool(
        "codex_merge",
        "Fold one or more duplicate codex entries into a single target. Provide the final merged content. Source entries are deleted and any links across the codex pointing at sources are rewritten to target. Use this aggressively when you spot duplicates.",
        {
          targetId: z.string().min(1),
          sourceIds: z.array(z.string().min(1)).min(1),
          kind: z.enum(CODEX_KINDS),
          title: z.string().min(1),
          body: z.string().min(1),
          sections: z.array(sectionSchema).optional(),
          tags: z.array(z.string()).optional(),
          links: z.array(linkSchema).optional(),
          visibility: z.enum(["public", "dm", "player"]).optional(),
          rationale: z.string().min(1),
        },
        async (a) => {
          if (!liveCodex.has(a.targetId)) return { content: [{ type: "text", text: `error: target ${a.targetId} not found` }], isError: true };
          for (const s of a.sourceIds) {
            if (s === a.targetId) return { content: [{ type: "text", text: `error: source equals target` }], isError: true };
            if (!liveCodex.has(s)) return { content: [{ type: "text", text: `error: source ${s} not found` }], isError: true };
          }
          const target = {
            id: a.targetId,
            kind: a.kind,
            title: a.title,
            body: a.body,
            sections: a.sections,
            tags: a.tags,
            links: a.links,
            visibility: a.visibility ?? "public",
          };
          collectedUpserts.push(target);
          liveCodex.set(a.targetId, target as Partial<CodexEntry>);

          const sourceSet = new Set(a.sourceIds);
          for (const [otherId, other] of liveCodex.entries()) {
            if (otherId === a.targetId || sourceSet.has(otherId)) continue;
            const links = other.links as CodexLink[] | undefined;
            if (!links?.length) continue;
            let mutated = false;
            const next: CodexLink[] = [];
            const seen = new Set<string>();
            for (const l of links) {
              const remapped = sourceSet.has(l.targetId) ? { ...l, targetId: a.targetId } : l;
              const key = `${remapped.relation}:${remapped.targetId}`;
              if (seen.has(key)) { mutated = true; continue; }
              seen.add(key);
              if (remapped !== l) mutated = true;
              next.push(remapped);
            }
            if (mutated) {
              collectedUpserts.push({
                id: otherId,
                kind: other.kind as CodexKind,
                title: other.title ?? "",
                body: other.body ?? "",
                sections: other.sections,
                tags: other.tags,
                links: next,
                visibility: (other.visibility as CodexEntry["visibility"]) ?? "public",
              });
              other.links = next;
            }
          }

          for (const s of a.sourceIds) {
            collectedDeletes.add(s);
            liveCodex.delete(s);
          }
          mergeCalls++;
          console.log(`[audit] codex_merge #${mergeCalls}: ${a.sourceIds.length} → ${a.title} (${a.rationale.slice(0, 100)})`);
          cb.onPartial?.({ toolUse: { name: "codex_merge", preview: `${a.sourceIds.length} → ${a.title}` } });
          return { content: [{ type: "text", text: `merged ${a.sourceIds.length} source(s) into ${a.title}` }] };
        }
      ),
      tool(
        "codex_link",
        "Add a typed relation between two existing codex entries that was established in chat but isn't in the links graph yet.",
        {
          sourceId: z.string().min(1),
          relation: z.string().min(1),
          targetId: z.string().min(1),
          note: z.string().optional(),
          rationale: z.string().min(1),
        },
        async (a) => {
          const src = liveCodex.get(a.sourceId);
          const tgt = liveCodex.get(a.targetId);
          if (!src) return { content: [{ type: "text", text: `error: no source ${a.sourceId}` }], isError: true };
          if (!tgt) return { content: [{ type: "text", text: `error: no target ${a.targetId}` }], isError: true };
          const existing = (src.links ?? []) as CodexLink[];
          if (existing.some((l) => l.relation === a.relation && l.targetId === a.targetId)) {
            return { content: [{ type: "text", text: "link already exists" }] };
          }
          const nextLinks = [...existing, { relation: a.relation, targetId: a.targetId, note: a.note }];
          collectedUpserts.push({
            id: src.id!,
            kind: src.kind as CodexKind,
            title: src.title ?? "",
            body: src.body ?? "",
            tags: src.tags,
            links: nextLinks,
            visibility: (src.visibility as CodexEntry["visibility"]) ?? "public",
          });
          src.links = nextLinks;
          linkCalls++;
          console.log(`[audit] codex_link #${linkCalls}: ${src.title} -[${a.relation}]→ ${tgt.title}`);
          cb.onPartial?.({ toolUse: { name: "codex_link", preview: `${src.title} -[${a.relation}]→ ${tgt.title}` } });
          return { content: [{ type: "text", text: `linked: ${src.title} -[${a.relation}]→ ${tgt.title}` }] };
        }
      ),
    ],
  });

  const prompt = buildAuditPrompt(codex, chat);

  let narration = "";
  try {
    const q = query({
      prompt,
      options: {
        model: AUDIT_MODEL,
        systemPrompt: AUDIT_SYSTEM_PROMPT,
        mcpServers: { audit: codexServer },
        allowedTools: [
          "mcp__audit__codex_upsert",
          "mcp__audit__codex_link",
          "mcp__audit__codex_merge",
          "mcp__audit__codex_get",
          "mcp__audit__codex_search",
          "mcp__audit__codex_delete",
        ],
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        includePartialMessages: true,
        maxThinkingTokens: 8000,
        stderr: (d) => process.stderr.write(`[audit-sdk] ${d}`),
      },
    });

    let thinkingBuf = "";
    let textBuf = "";
    for await (const msg of q) {
      if (msg.type === "stream_event") {
        const ev: any = msg.event;
        if (ev?.type === "content_block_delta") {
          const d = ev.delta;
          if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
            thinkingBuf += d.thinking;
            cb.onPartial?.({ thinking: thinkingBuf });
          } else if (d?.type === "text_delta" && typeof d.text === "string") {
            textBuf += d.text;
            cb.onPartial?.({ text: textBuf });
          }
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") narration += block.text;
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && !narration) narration = msg.result;
      }
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
    console.error(`[audit] FAILED after ${elapsed}s, ${upsertCalls} upserts + ${linkCalls} links:`, err);
    return { narration: `(audit failed — ${(err as Error).message})` };
  }

  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(`[audit] DONE in ${elapsed}s — ${upsertCalls} upserts, ${linkCalls} links, ${mergeCalls} merges, ${collectedDeletes.size} deletes, narration ${narration.length} chars`);

  reply.narration = narration.trim() || undefined;
  if (collectedUpserts.length) reply.codexUpserts = collectedUpserts;
  if (collectedDeletes.size) reply.codexDeletes = [...collectedDeletes];
  return reply;
}

function buildAuditPrompt(codex: CodexEntry[], chat: ChatEntry[]): string {
  return [
    `# CODEX AUDIT — full pass`,
    "",
    `You have ${codex.length} codex entries to review and ${chat.length} chat messages to use as ground truth.`,
    "",
    "## CODEX INDEX (every entry, compact)",
    codex.length === 0 ? "(empty)" : codex.map((e) => `- ${e.id}  [${e.kind}]  ${e.title}  (${(e.tags ?? []).length}t/${(e.links ?? []).length}l${e.sections?.length ? `/${e.sections.length}s` : ""})`).join("\n"),
    "",
    "## FULL CHAT HISTORY",
    "(role tags: [player] = human, [dm] = human host, [agent] = AI, [system] = directive)",
    "",
    chat.length === 0
      ? "(no chat history yet)"
      : chat.map((m) => `[${m.role}] ${m.author} (${m.channel}): ${m.text}`).join("\n\n"),
    "",
    "## EVERY CODEX ENTRY (full bodies, no truncation)",
    "",
    codex.length === 0
      ? "(no codex entries)"
      : codex.map((e) => renderEntry(e, codex)).join("\n\n---\n\n"),
    "",
    "## YOUR JOB",
    "Go through every codex entry above, compare it to the chat history, and call codex_upsert / codex_link / codex_merge / codex_delete to fix what's wrong. Be conservative. Cite the chat in your `rationale` argument. When the chat doesn't establish something the entry claims, either trim it or move it under a **Possibilities (unconfirmed):** subsection and tag the entry `speculation`.",
    "",
    "After your tool calls, reply with a brief bulleted summary of what you changed.",
  ].join("\n");
}

function renderEntry(e: CodexEntry, all: CodexEntry[]): string {
  const tagLine = e.tags?.length ? `tags: ${e.tags.join(", ")}` : "tags: (none)";
  const linkLines = (e.links ?? []).map((l) => {
    const tgt = all.find((x) => x.id === l.targetId);
    return `  → ${l.relation}: ${tgt ? `${tgt.title} (${tgt.kind}, id=${tgt.id})` : `<missing ${l.targetId}>`}${l.note ? ` — ${l.note}` : ""}`;
  });
  const sectionBlock = (e.sections ?? []).map((s) => `--- section: ${s.title} ---\n${s.body}`).join("\n");
  return [
    `### [${e.kind}] ${e.title}`,
    `id: ${e.id}`,
    tagLine,
    linkLines.length ? `links:\n${linkLines.join("\n")}` : "links: (none)",
    "body:",
    e.body,
    sectionBlock,
  ].filter(Boolean).join("\n");
}
