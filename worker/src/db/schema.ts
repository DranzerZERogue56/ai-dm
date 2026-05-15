import { pgTable, text, timestamp, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("worldbuilder"),
  inviteCode: text("invite_code").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const codexEntries = pgTable(
  "codex_entries",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sections: jsonb("sections"),
    tags: text("tags").array(),
    links: jsonb("links"),
    data: jsonb("data"),
    imageUrl: text("image_url"),
    visibility: text("visibility").notNull().default("public"),
    ownerId: text("owner_id"),
    // pgvector column added via raw SQL migration; Drizzle treats as unknown.
    embedding: text("embedding"), // placeholder, see migration note
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("codex_campaign_idx").on(t.campaignId),
    byKind: index("codex_kind_idx").on(t.campaignId, t.kind),
  })
);

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  channel: text("channel").notNull(),
  authorId: text("author_id").notNull(),
  authorName: text("author_name").notNull(),
  authorRole: text("author_role").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invites = pgTable("invites", {
  token: text("token").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(), // 'dm' | 'player'
  pcId: text("pc_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
  lastUsedAt: timestamp("last_used_at"),
}, (t) => ({
  byCampaign: index("invites_campaign_idx").on(t.campaignId),
}));

export const sessionSummaries = pgTable("session_summaries", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Run once against your DB to enable pgvector and convert embedding column:
//   CREATE EXTENSION IF NOT EXISTS vector;
//   ALTER TABLE codex_entries ALTER COLUMN embedding TYPE vector(1536) USING NULL;
//   CREATE INDEX codex_embedding_idx ON codex_entries USING ivfflat (embedding vector_cosine_ops);
export const _pgvectorNote = sql``;
