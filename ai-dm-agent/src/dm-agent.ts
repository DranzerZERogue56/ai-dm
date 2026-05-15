import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CodexEntry, CodexKind, CodexLink, CodexSection, CombatState, CampaignMode, DmPartial } from "@ai-dm/shared";

export interface DmStreamCallbacks {
  onPartial?: (p: DmPartial) => void;
}

interface RoomState {
  mode: CampaignMode;
  codex: CodexEntry[];
  combat: CombatState;
  recentChat: { author: string; text: string; channel: "dm" | "assistant" }[];
}

export interface DmTurnReply {
  narration?: string;
  codexUpserts?: (Partial<CodexEntry> & { kind: CodexKind; title: string; body: string })[];
  codexDeletes?: string[];
  combat?: CombatState;
  mode?: CampaignMode;
}

const CODEX_KINDS = [
  "timeline","town","npc","faction","quest","pc","location","item","lore","session_note","map","calendar","journal","house_rule",
] as const;

const DM_MODEL = process.env.DM_MODEL ?? "claude-sonnet-4-6";

const DM_SYSTEM_PROMPT = `You are the AI Dungeon Master for a collaborative D&D 5e campaign run inside a terminal-styled web app.

You operate in one of two modes (the current mode is given each turn):

- WORLDBUILDER: You are helping players co-author the campaign. Ask one focused, evocative question at a time. Alternate between round-robin (one named player answers) and simultaneous (all players answer). When players give you content (a town, an NPC, a faction, a quest hook, a house rule, etc.), CALL THE codex_upsert TOOL to commit it. Never wait for approval — write it down and move on.

- PLAY: You are running a live session. Narrate scenes in tight, second-person, sensory prose. Voice NPCs in character. Call for ability checks when appropriate ("roll Persuasion"). Adjudicate combat using 5e rules unless a House Rule (kind: "house_rule" in the codex) overrides — house rules ALWAYS win. Use the combat_update tool when initiative starts, HP changes, or conditions change. Use codex_upsert to record what happened (new NPCs met, quest status changes, lore discovered).

# One entry per named thing
Every named entity (an NPC, a town, a faction, a quest) is ONE codex entry. Never create a second entry "About Pax's backstory" or "About Pax's family". If you need more depth, use the sections argument on codex_upsert to add structured tabs (e.g. {title:"Backstory",body:"..."}, {title:"Family",body:"..."}). Tabs are how character-sheet-style detail lives.

When you discover that two entries refer to the same thing (two NPC entries for the same person, or the same town under two names), CALL THE codex_merge TOOL to fold them into one. Don't leave duplicates.

# Tags and links
Codex entries form a graph. Every codex_upsert SHOULD include:
- "tags": short kebab-case keywords for clustering (e.g. ["coastal","corrupt","arc-1"]). Reuse existing tags when they fit — check the RELEVANT CODEX section.
- "links": typed references to OTHER existing entries by id. Use the codex_link tool if you only need to add a relation without rewriting an entry's body. Common relations: "lives_in", "member_of", "rules", "allied_with", "enemy_of", "located_in", "owns", "originates_from", "appeared_in", "related_to". Pick descriptive snake_case relations.

When you upsert an NPC, link them to their faction, their hometown, and any quests they're tied to. When you upsert a quest, link it to the NPCs giving it and any locations it points at. This is how you keep context across sessions — every named thing should connect to its neighbors.

# Codex editing authority (IMPORTANT)
You have direct write access to the entire codex via tools. The PLAYERS CONTROL THE CODEX. When they say things like:
- "change Pax's backstory to ..."  → call codex_upsert immediately with the new body/sections
- "Pax doesn't have a sister, remove that"  → call codex_upsert with the corrected body, or codex_delete if removing the whole entry
- "merge those two NPCs"  → call codex_merge
- "tag everyone from Brackmoor as 'coastal'"  → call codex_search for tag='brackmoor' then codex_upsert each with the new tag
- "what entries do we have about the Sable Guard?"  → call codex_search and report results
- "show me Pax's full sheet"  → call codex_get and quote it back

Rules:
- DO NOT ask for confirmation. The player asked; just do it. Confirm afterward.
- DO NOT narrate the change ("the threads of fate shift..."). Use the tool, then say one line: "Updated Pax: removed the sister reference."
- The CODEX INDEX section lists EVERY entry's id and title. If the player references something by name, look up the id there and act on it. If you can't find a match, call codex_search.
- When fixing a player correction, prefer codex_upsert over creating a new entry. Same-name entries are duplicates and should be merged.

General:
- Keep replies tight. Two or three paragraphs of narration max per turn.
- Refer to the codex you are given. Do not invent contradictions with established facts.
- When you commit something to the codex, briefly mention it in your reply so players know ("noted: Vex'thal, half-elf bard, frequents the Sable Tankard").
- Only call mode_set when the players explicitly want to switch modes.`;

const linkSchema = z.object({
  relation: z.string().min(1).describe("snake_case relation, e.g. 'lives_in', 'member_of', 'enemy_of'"),
  targetId: z.string().min(1).describe("The id of the existing codex entry being linked to."),
  note: z.string().optional(),
});

const sectionSchema = z.object({
  title: z.string().min(1).describe("Short tab name, e.g. 'Backstory', 'Stats', 'Inventory', 'Relationships'"),
  body: z.string().min(1).describe("Markdown content for this tab."),
});

export async function runDmTurn(state: RoomState, userText: string, cb: DmStreamCallbacks = {}): Promise<DmTurnReply> {
  const reply: DmTurnReply = {};
  const collectedUpserts: NonNullable<DmTurnReply["codexUpserts"]> = [];
  const collectedDeletes = new Set<string>();
  // Local view of codex including pending upserts within this turn, for link operations.
  const liveCodex = new Map<string, Partial<CodexEntry>>();
  for (const e of state.codex) liveCodex.set(e.id, { ...e });

  const codexServer = createSdkMcpServer({
    name: "codex",
    version: "0.2.0",
    tools: [
      tool(
        "codex_upsert",
        "Create or update a Campaign Codex entry. One entry per named thing — never split details across multiple entries. Use sections for structured tabs (Backstory, Stats, Inventory, etc.). Always include tags. Include links to existing entries when there's an obvious connection.",
        {
          id: z.string().optional().describe("Existing entry id to update. Omit to create a new entry."),
          kind: z.enum(CODEX_KINDS),
          title: z.string().min(1),
          body: z.string().min(1).describe("Short overview (top of the entry, ~1-3 paragraphs). Long detail belongs in sections."),
          sections: z.array(sectionSchema).optional().describe("Additional tabs beyond the overview — Backstory, Appearance, Stats, Inventory, Relationships, etc."),
          tags: z.array(z.string()).optional().describe("kebab-case keywords; reuse existing tags when they fit"),
          links: z.array(linkSchema).optional().describe("typed edges to other existing entries by id"),
          visibility: z.enum(["public", "dm", "player"]).optional(),
        },
        async (args) => {
          const entry: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string } = {
            id: args.id,
            kind: args.kind,
            title: args.title,
            body: args.body,
            sections: args.sections,
            tags: args.tags,
            links: args.links,
            visibility: args.visibility ?? "public",
          };
          collectedUpserts.push(entry);
          // Reflect into live map so subsequent codex_link calls in this turn see it.
          const known = args.id ?? `pending-${collectedUpserts.length}`;
          liveCodex.set(known, entry as Partial<CodexEntry>);
          cb.onPartial?.({ toolUse: { name: "codex_upsert", preview: `[${args.kind}] ${args.title}${args.sections?.length ? ` (${args.sections.length} tabs)` : ""}` } });
          return { content: [{ type: "text", text: `committed ${args.kind}: ${args.title}${args.sections?.length ? ` with ${args.sections.length} tabs` : ""}${args.tags?.length ? ` (tags: ${args.tags.join(",")})` : ""}${args.links?.length ? ` ${args.links.length} link(s)` : ""}` }] };
        }
      ),
      tool(
        "codex_link",
        "Add a typed relation between two existing codex entries by id, without rewriting either entry's body. Use this when the only change you want to make is to record that two entries are connected.",
        {
          sourceId: z.string().min(1),
          relation: z.string().min(1),
          targetId: z.string().min(1),
          note: z.string().optional(),
        },
        async (args) => {
          const src = liveCodex.get(args.sourceId);
          if (!src) {
            return { content: [{ type: "text", text: `error: no codex entry with id ${args.sourceId}` }], isError: true };
          }
          const tgt = liveCodex.get(args.targetId);
          if (!tgt) {
            return { content: [{ type: "text", text: `error: no codex entry with id ${args.targetId}` }], isError: true };
          }
          const existing = (src.links ?? []) as CodexLink[];
          // Skip exact duplicates.
          if (existing.some((l) => l.relation === args.relation && l.targetId === args.targetId)) {
            return { content: [{ type: "text", text: `link already exists` }] };
          }
          const nextLinks = [...existing, { relation: args.relation, targetId: args.targetId, note: args.note }];
          // Emit a tags/links-only upsert (must include kind/title/body because they're required on the wire).
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
          cb.onPartial?.({ toolUse: { name: "codex_link", preview: `${src.title} -[${args.relation}]→ ${tgt.title}` } });
          return { content: [{ type: "text", text: `linked: ${src.title} -[${args.relation}]→ ${tgt.title}` }] };
        }
      ),
      tool(
        "codex_merge",
        "Fold one or more source codex entries into a single target entry. Use when you discover duplicates (same NPC under two ids, same town with two names). Provide the final merged title/body/sections/tags/links — they replace the target. Source entries are deleted. Any links across the codex pointing at source ids are automatically rewritten to target.",
        {
          targetId: z.string().min(1).describe("The id of the entry to keep."),
          sourceIds: z.array(z.string().min(1)).min(1).describe("ids of entries to fold into target. Must be different from targetId."),
          kind: z.enum(CODEX_KINDS),
          title: z.string().min(1),
          body: z.string().min(1),
          sections: z.array(sectionSchema).optional(),
          tags: z.array(z.string()).optional(),
          links: z.array(linkSchema).optional(),
          visibility: z.enum(["public", "dm", "player"]).optional(),
          rationale: z.string().min(1).describe("One sentence why these are the same thing — quote chat if possible."),
        },
        async (a) => {
          if (!liveCodex.has(a.targetId)) return { content: [{ type: "text", text: `error: target ${a.targetId} not found` }], isError: true };
          for (const s of a.sourceIds) {
            if (s === a.targetId) return { content: [{ type: "text", text: `error: source equals target` }], isError: true };
            if (!liveCodex.has(s)) return { content: [{ type: "text", text: `error: source ${s} not found` }], isError: true };
          }
          // 1. Update target with the merged content.
          const target: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string } = {
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

          // 2. Rewrite any incoming links from OTHER entries pointing at any source -> target.
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

          // 3. Mark sources as deleted.
          for (const s of a.sourceIds) {
            collectedDeletes.add(s);
            liveCodex.delete(s);
          }

          cb.onPartial?.({ toolUse: { name: "codex_merge", preview: `${a.sourceIds.length} → ${a.title} (${a.rationale.slice(0, 80)})` } });
          return { content: [{ type: "text", text: `merged ${a.sourceIds.length} source(s) into ${a.title}; incoming links rewritten` }] };
        }
      ),
      tool(
        "codex_get",
        "Read one codex entry's full body, sections, tags, and links by id. Use when the CODEX INDEX lists an entry you want to act on but its body wasn't in RELEVANT CODEX ENTRIES.",
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
        "Find codex entry ids matching kind, tag, and/or title substring. Returns id + title + kind for each match.",
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
        "Delete a single codex entry by id. Use when the player explicitly asks to remove something. Different from codex_merge — this is a hard delete with no source-to-target absorption.",
        {
          id: z.string().min(1),
          rationale: z.string().min(1).describe("Why this entry is being deleted (player asked, duplicate, never established, etc.)."),
        },
        async (a) => {
          if (!liveCodex.has(a.id)) return { content: [{ type: "text", text: `error: no entry with id ${a.id}` }], isError: true };
          const e = liveCodex.get(a.id)!;
          collectedDeletes.add(a.id);
          liveCodex.delete(a.id);
          cb.onPartial?.({ toolUse: { name: "codex_delete", preview: `${e.title} — ${a.rationale.slice(0, 80)}` } });
          return { content: [{ type: "text", text: `deleted ${a.id} (${e.title})` }] };
        }
      ),
      tool(
        "combat_update",
        "Replace the combat tracker state. Use to start/end combat, update HP or conditions, or advance turns. Initiative roll order determines turnIndex.",
        {
          active: z.boolean(),
          round: z.number().int().nonnegative(),
          turnIndex: z.number().int().nonnegative(),
          combatants: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              initiative: z.number().int(),
              hp: z.number().int(),
              maxHp: z.number().int(),
              ac: z.number().int(),
              conditions: z.array(z.string()),
              isPlayer: z.boolean(),
            })
          ),
        },
        async (args) => {
          reply.combat = args as CombatState;
          return { content: [{ type: "text", text: "combat updated" }] };
        }
      ),
      tool(
        "mode_set",
        "Switch the campaign mode. Only call when players explicitly want to start or end a play session.",
        { mode: z.enum(["worldbuilder", "play"]) },
        async (args) => {
          reply.mode = args.mode;
          return { content: [{ type: "text", text: `mode -> ${args.mode}` }] };
        }
      ),
    ],
  });

  const userPrompt = buildUserPrompt(state, userText);

  let narration = "";
  try {
    const q = query({
      prompt: userPrompt,
      options: {
        model: DM_MODEL,
        systemPrompt: DM_SYSTEM_PROMPT,
        mcpServers: { codex: codexServer },
        allowedTools: [
          "mcp__codex__codex_upsert",
          "mcp__codex__codex_link",
          "mcp__codex__codex_merge",
          "mcp__codex__codex_get",
          "mcp__codex__codex_search",
          "mcp__codex__codex_delete",
          "mcp__codex__combat_update",
          "mcp__codex__mode_set",
        ],
        permissionMode: "bypassPermissions",
        maxTurns: 6,
        includePartialMessages: true,
        maxThinkingTokens: 4000,
        stderr: (d) => process.stderr.write(`[dm-sdk] ${d}`),
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
    console.error("[dm-agent] query failed:", err);
    return { narration: `(DM is silent — agent error: ${(err as Error).message})` };
  }

  reply.narration = narration.trim() || undefined;
  if (collectedUpserts.length) reply.codexUpserts = collectedUpserts;
  if (collectedDeletes.size) reply.codexDeletes = [...collectedDeletes];
  return reply;
}

function buildUserPrompt(state: RoomState, userText: string): string {
  const houseRules = state.codex.filter((e) => e.kind === "house_rule");
  const relevant = ragSelect(state, userText, 8);
  const allTags = Array.from(new Set(state.codex.flatMap((e) => e.tags ?? []))).sort();
  const recent = state.recentChat.slice(-12).map((m) => `${m.author} [${m.channel}]: ${m.text}`).join("\n");

  return [
    `# CURRENT MODE: ${state.mode.toUpperCase()}`,
    "",
    houseRules.length
      ? `# HOUSE RULES (always take precedence over SRD)\n${houseRules.map((r) => `- ${r.title}: ${r.body}`).join("\n")}`
      : "# HOUSE RULES\n(none yet)",
    "",
    allTags.length ? `# EXISTING TAGS (reuse when they fit)\n${allTags.join(", ")}` : "",
    "",
    `# CODEX INDEX (${state.codex.length} entries — call codex_get(id) for full body if not listed below)`,
    state.codex.length
      ? state.codex.map((e) => `- ${e.id}  [${e.kind}]  ${e.title}  (${(e.tags ?? []).length}t/${(e.links ?? []).length}l${e.sections?.length ? `/${e.sections.length}s` : ""})${e.tags?.length ? `  ::  ${(e.tags ?? []).join(",")}` : ""}`).join("\n")
      : "(empty)",
    "",
    `# RELEVANT CODEX ENTRIES — full bodies (${relevant.length}/${state.codex.length})`,
    relevant.length
      ? relevant.map((e) => renderEntryForPrompt(e, state.codex)).join("\n\n")
      : "(none matched — use codex_get or codex_search to look things up)",
    "",
    `# COMBAT STATE`,
    state.combat.active
      ? `Active. Round ${state.combat.round}. Turn ${state.combat.turnIndex}.\n${state.combat.combatants.map((c) => `- ${c.name} (init ${c.initiative}, HP ${c.hp}/${c.maxHp}, AC ${c.ac}${c.conditions.length ? `, ${c.conditions.join(",")}` : ""})`).join("\n")}`
      : "Not in combat.",
    "",
    `# RECENT CHAT`,
    recent || "(this is the first message)",
    "",
    `# PLAYER INPUT`,
    userText,
  ].filter((s) => s !== "").join("\n");
}

function renderEntryForPrompt(e: CodexEntry, all: CodexEntry[]): string {
  const tagLine = e.tags?.length ? `tags: ${e.tags.join(", ")}` : "";
  const linkLines = (e.links ?? []).map((l) => {
    const tgt = all.find((x) => x.id === l.targetId);
    return `  → ${l.relation}: ${tgt ? `${tgt.title} (${tgt.kind})` : `<missing ${l.targetId}>`}${l.note ? ` — ${l.note}` : ""}`;
  });
  const sectionBlock = (e.sections ?? []).map((s) => `### ${s.title}\n${s.body}`).join("\n\n");
  return [
    `## [${e.kind}] ${e.title} (id: ${e.id})`,
    tagLine,
    ...linkLines,
    e.body,
    sectionBlock,
  ].filter(Boolean).join("\n");
}

// Lexical match + 1-hop graph expansion via links.
function ragSelect(state: RoomState, q: string, k = 8): CodexEntry[] {
  const tokens = q.toLowerCase().split(/\W+/).filter((t) => t.length >= 3);
  let seeds: CodexEntry[] = [];
  if (!tokens.length) {
    seeds = state.codex.slice(0, k);
  } else {
    const scored = state.codex.map((e) => {
      const hay = (e.title + " " + e.body + " " + (e.tags ?? []).join(" ")).toLowerCase();
      const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { e, score };
    });
    seeds = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((x) => x.score > 0)
      .map((x) => x.e);
  }

  const byId = new Map(state.codex.map((e) => [e.id, e] as const));
  const out = new Map<string, CodexEntry>();
  for (const s of seeds) out.set(s.id, s);
  // 1-hop expansion: pull in everything our seeds link to.
  const maxTotal = Math.max(k * 2, 16);
  for (const s of seeds) {
    for (const l of s.links ?? []) {
      if (out.size >= maxTotal) break;
      const tgt = byId.get(l.targetId);
      if (tgt && !out.has(tgt.id)) out.set(tgt.id, tgt);
    }
    if (out.size >= maxTotal) break;
  }
  return [...out.values()];
}
