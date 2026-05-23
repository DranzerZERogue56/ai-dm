export type CampaignMode = "worldbuilder" | "play";

export type CodexKind =
  | "timeline"
  | "town"
  | "npc"
  | "faction"
  | "quest"
  | "pc"
  | "location"
  | "item"
  | "lore"
  | "session_note"
  | "map"
  | "calendar"
  | "journal"
  | "house_rule";

export interface CodexLink {
  relation: string;
  targetId: string;
  note?: string;
}

export interface CodexSection {
  title: string;
  body: string;
}

export type AbilityKey = "str" | "dex" | "con" | "int" | "wis" | "cha";

export const SKILL_TO_ABILITY: Record<string, AbilityKey> = {
  acrobatics: "dex",
  "animal handling": "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  "sleight of hand": "dex",
  stealth: "dex",
  survival: "wis",
};

export interface PCSheet {
  // identity
  level?: number;
  classes?: { name: string; level: number; subclass?: string }[];
  race?: string;
  background?: string;
  alignment?: string;
  xp?: number;
  // abilities
  abilities?: Partial<Record<AbilityKey, number>>;
  proficiencyBonus?: number;
  // combat
  ac?: number;
  initiative?: number;
  speed?: number;
  hp?: { current: number; max: number; temp?: number };
  hitDice?: { total: string; used: number };
  deathSaves?: { successes: number; failures: number };
  // saves & skills
  savingThrows?: Partial<Record<AbilityKey, { proficient: boolean; bonus?: number }>>;
  skills?: Record<string, { proficient?: boolean; expertise?: boolean; bonus?: number; ability?: AbilityKey }>;
  // gear
  inventory?: { id: string; name: string; qty: number; weight?: number; notes?: string; equipped?: boolean }[];
  gold?: number;
  // spells
  spells?: {
    spellcastingAbility?: AbilityKey;
    spellSaveDc?: number;
    spellAttackBonus?: number;
    slots?: Record<string, { max: number; used: number }>;
    known?: { name: string; level: number; prepared?: boolean; notes?: string }[];
  };
  // features
  features?: { name: string; source?: string; notes?: string }[];
  conditions?: string[];
  // narrative shortcuts (otherwise live in entry.sections)
  appearance?: string;
  personality?: string;
  ideals?: string;
  bonds?: string;
  flaws?: string;
}

export interface CodexEntry {
  id: string;
  campaignId: string;
  kind: CodexKind;
  title: string;
  body: string;
  sections?: CodexSection[];
  tags?: string[];
  links?: CodexLink[];
  data?: Record<string, unknown>;
  imageUrl?: string;
  visibility: "public" | "dm" | "player";
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Combatant {
  id: string;
  name: string;
  initiative: number;
  hp: number;
  maxHp: number;
  ac: number;
  conditions: string[];
  isPlayer: boolean;
}

export interface CombatState {
  active: boolean;
  round: number;
  turnIndex: number;
  combatants: Combatant[];
}

export interface ChatMessage {
  id: string;
  campaignId: string;
  channel: "dm" | "assistant";
  authorId: string;
  authorName: string;
  authorRole: "dm" | "player" | "agent" | "system";
  text: string;
  recipientId?: string;     // when set, this message is a whisper visible only to sender + recipient + DM + agent
  invokeAi?: boolean;       // when true, the AI-DM should respond even if not paused/explicitly addressed
  speakAsNpcId?: string;    // when set, the message represents this NPC's voice (rendered with the NPC's name)
  speakAsNpcName?: string;  // resolved server-side from codex so clients don't need to look it up
  createdAt: string;
}

export interface VaultChange {
  entryId: string;
  kind: string;
  title: string;
  fields: ("body" | "sections" | "tags" | "visibility" | "title")[];
  diffSummary: string;
  // The full entry the client should upsert if the DM accepts the change.
  next: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string };
}

export interface RollRequest {
  id: string;
  fromId: string;            // who is asking
  fromName: string;
  targetId: string;          // target participant id (their token)
  label: string;             // "Stealth", "Persuasion", etc.
  dice: string;              // "1d20+5" or "1d20"
  dc?: number;
  whisper?: boolean;         // whisper to target only (otherwise public roll request)
  resolvedRollId?: string;   // set once player completes
  createdAt: string;
}

export interface DiceRoll {
  id: string;
  authorId: string;
  authorName: string;
  notation: string;
  rolls: number[];
  total: number;
  label?: string;
  createdAt: string;
}

export type DmStatus = "thinking" | "idle";

export interface DmPartial {
  thinking?: string;
  text?: string;
  toolUse?: { name: string; preview?: string };
}

export type ClientToServer =
  | { type: "hello"; campaignId: string; displayName: string; role: "dm" | "player" | "agent"; token?: string }
  | { type: "chat"; channel: "dm" | "assistant"; text: string; recipientId?: string; invokeAi?: boolean; speakAsNpcId?: string }
  | { type: "roll"; notation: string; label?: string; rollRequestId?: string }
  | { type: "roll.request"; targetId: string; label: string; dice: string; dc?: number; whisper?: boolean }
  | { type: "ai.pause"; paused: boolean }
  | { type: "vault.scan"; requestId: string }
  | { type: "vault.diff"; requestId: string; changes: VaultChange[]; scannedFiles: number; error?: string }
  | { type: "vault.apply"; requestId: string; changes: VaultChange[] }
  | { type: "codex.upsert"; entry: Partial<CodexEntry> & { kind: CodexKind; title: string; body: string } }
  | { type: "codex.delete"; id: string }
  | { type: "combat.update"; state: CombatState }
  | { type: "mode.set"; mode: CampaignMode }
  | { type: "dm.status"; state: DmStatus; detail?: string }
  | { type: "dm.partial"; partial: DmPartial }
  | { type: "session.wrapup"; reason?: string }
  | { type: "codex.audit"; reason?: string };

export interface PersistenceInfo {
  storage: boolean;
  db: boolean;
}

export type ServerToClient =
  | { type: "snapshot"; campaignId: string; mode: CampaignMode; codex: CodexEntry[]; combat: CombatState; participants: Participant[]; persistence: PersistenceInfo; chat: ChatMessage[]; aiPaused: boolean }
  | { type: "chat"; message: ChatMessage }
  | { type: "roll"; roll: DiceRoll }
  | { type: "codex.upsert"; entry: CodexEntry }
  | { type: "codex.delete"; id: string }
  | { type: "codex.hide"; id: string }
  | { type: "ai.paused"; paused: boolean }
  | { type: "roll.request"; request: RollRequest }
  | { type: "vault.scan"; requestId: string }
  | { type: "vault.diff"; requestId: string; changes: VaultChange[]; scannedFiles: number; error?: string }
  | { type: "vault.apply"; requestId: string; changes: VaultChange[] }
  | { type: "combat.update"; state: CombatState }
  | { type: "mode.set"; mode: CampaignMode }
  | { type: "participants"; participants: Participant[] }
  | { type: "dm.status"; state: DmStatus; detail?: string }
  | { type: "dm.partial"; partial: DmPartial }
  | { type: "session.wrapup"; reason?: string }
  | { type: "codex.audit"; reason?: string }
  | { type: "error"; message: string };

export interface Participant {
  id: string;
  displayName: string;
  role: "dm" | "player" | "agent";
  pcId?: string;
}

export interface Invite {
  token: string;
  campaignId: string;
  displayName: string;
  role: "dm" | "player";
  pcId?: string;
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}
