import { eq, and, desc, asc, gt } from "drizzle-orm";
import type { CodexEntry, CodexLink, CodexSection, ChatMessage, Invite } from "@ai-dm/shared";
import * as schema from "./schema";
import type { DB } from "./client";

export async function ensureCampaign(db: DB, row: { id: string; name: string; inviteCode: string }) {
  await db
    .insert(schema.campaigns)
    .values({ id: row.id, name: row.name, inviteCode: row.inviteCode })
    .onConflictDoNothing();
}

export async function getCampaign(db: DB, id: string) {
  const rows = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listCodex(db: DB, campaignId: string): Promise<CodexEntry[]> {
  const rows = await db
    .select()
    .from(schema.codexEntries)
    .where(eq(schema.codexEntries.campaignId, campaignId))
    .orderBy(desc(schema.codexEntries.updatedAt));
  return rows.map(rowToEntry);
}

export async function upsertCodex(db: DB, entry: CodexEntry) {
  await db
    .insert(schema.codexEntries)
    .values({
      id: entry.id,
      campaignId: entry.campaignId,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      sections: entry.sections ?? null,
      tags: entry.tags ?? null,
      links: entry.links ?? null,
      data: entry.data ?? null,
      imageUrl: entry.imageUrl ?? null,
      visibility: entry.visibility,
      ownerId: entry.ownerId ?? null,
    })
    .onConflictDoUpdate({
      target: schema.codexEntries.id,
      set: {
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        sections: entry.sections ?? null,
        tags: entry.tags ?? null,
        links: entry.links ?? null,
        data: entry.data ?? null,
        imageUrl: entry.imageUrl ?? null,
        visibility: entry.visibility,
        ownerId: entry.ownerId ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function deleteCodex(db: DB, campaignId: string, id: string) {
  await db
    .delete(schema.codexEntries)
    .where(and(eq(schema.codexEntries.campaignId, campaignId), eq(schema.codexEntries.id, id)));
}

// ----- Chat -----

export async function insertChat(db: DB, message: ChatMessage) {
  await db.insert(schema.chatMessages).values({
    id: message.id,
    campaignId: message.campaignId,
    channel: message.channel,
    authorId: message.authorId,
    authorName: message.authorName,
    authorRole: message.authorRole,
    text: message.text,
  }).onConflictDoNothing();
}

export async function recentChat(db: DB, campaignId: string, limit = 5000): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.campaignId, campaignId))
    .orderBy(asc(schema.chatMessages.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    channel: r.channel as ChatMessage["channel"],
    authorId: r.authorId,
    authorName: r.authorName,
    authorRole: r.authorRole as ChatMessage["authorRole"],
    text: r.text,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ----- Invites -----

export async function upsertInvite(db: DB, inv: Invite) {
  await db.insert(schema.invites).values({
    token: inv.token,
    campaignId: inv.campaignId,
    displayName: inv.displayName,
    role: inv.role,
    pcId: inv.pcId ?? null,
    revokedAt: inv.revokedAt ? new Date(inv.revokedAt) : null,
    lastUsedAt: inv.lastUsedAt ? new Date(inv.lastUsedAt) : null,
  }).onConflictDoUpdate({
    target: schema.invites.token,
    set: {
      displayName: inv.displayName,
      role: inv.role,
      pcId: inv.pcId ?? null,
      revokedAt: inv.revokedAt ? new Date(inv.revokedAt) : null,
      lastUsedAt: inv.lastUsedAt ? new Date(inv.lastUsedAt) : null,
    },
  });
}

export async function listInvites(db: DB, campaignId: string): Promise<Invite[]> {
  const rows = await db.select().from(schema.invites).where(eq(schema.invites.campaignId, campaignId));
  return rows.map((r) => ({
    token: r.token,
    campaignId: r.campaignId,
    displayName: r.displayName,
    role: r.role as Invite["role"],
    pcId: r.pcId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString(),
  }));
}

function rowToEntry(r: typeof schema.codexEntries.$inferSelect): CodexEntry {
  return {
    id: r.id,
    campaignId: r.campaignId,
    kind: r.kind as CodexEntry["kind"],
    title: r.title,
    body: r.body,
    sections: (r.sections as CodexSection[] | null) ?? undefined,
    tags: (r.tags as string[] | null) ?? undefined,
    links: (r.links as CodexLink[] | null) ?? undefined,
    data: (r.data as Record<string, unknown> | null) ?? undefined,
    imageUrl: r.imageUrl ?? undefined,
    visibility: r.visibility as CodexEntry["visibility"],
    ownerId: r.ownerId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
