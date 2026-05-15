import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CodexEntry } from "@ai-dm/shared";

const HELPER_MODEL = process.env.HELPER_MODEL ?? "claude-haiku-4-5-20251001";

const HELPER_SYSTEM_PROMPT = `You are the Player Helper, a sidebar assistant in a D&D 5e campaign tool.
You answer rules questions and "what does my character know" questions for one specific player.
You can see the campaign's House Rules and any codex entries the player has access to. House Rules ALWAYS override the SRD.
You CANNOT see DM secrets — do not speculate about hidden lore, faction secrets, or NPC motives that aren't on the codex.
Keep answers tight: 1-3 sentences, or a short bulleted list. No narration, no roleplay — this is a reference tool.`;

interface HelperState {
  codex: CodexEntry[];
  recentChat: { author: string; text: string }[];
}

export async function runHelperTurn(state: HelperState, askerName: string, userText: string): Promise<string> {
  const houseRules = state.codex.filter((e) => e.kind === "house_rule");
  const visible = state.codex.filter((e) => e.visibility !== "dm");

  const prompt = [
    houseRules.length
      ? `# HOUSE RULES\n${houseRules.map((r) => `- ${r.title}: ${r.body}`).join("\n")}`
      : "# HOUSE RULES\n(none)",
    "",
    `# CODEX (player-visible, ${visible.length} entries)`,
    visible.length
      ? visible.slice(0, 30).map((e) => `## [${e.kind}] ${e.title}\n${e.body}`).join("\n\n")
      : "(empty)",
    "",
    `# QUESTION FROM ${askerName}`,
    userText,
  ].join("\n");

  let text = "";
  try {
    const q = query({
      prompt,
      options: {
        model: HELPER_MODEL,
        systemPrompt: HELPER_SYSTEM_PROMPT,
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        disallowedTools: ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"],
        stderr: (d) => process.stderr.write(`[helper-sdk] ${d}`),
      },
    });
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") text += block.text;
        }
      } else if (msg.type === "result" && msg.subtype === "success" && !text) {
        text = msg.result;
      }
    }
  } catch (err) {
    return `(helper unavailable — ${(err as Error).message})`;
  }
  return text.trim() || "(no reply)";
}
