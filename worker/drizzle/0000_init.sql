-- AI-DM initial schema. Run against your Postgres before first boot.
-- Works with Neon, Supabase, or local Postgres 15+.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'worldbuilder',
  invite_code  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS codex_entries (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  sections     JSONB,
  tags         TEXT[],
  links        JSONB,
  data         JSONB,
  image_url    TEXT,
  visibility   TEXT NOT NULL DEFAULT 'public',
  owner_id     TEXT,
  embedding    vector(1536),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codex_campaign_idx ON codex_entries(campaign_id);
CREATE INDEX IF NOT EXISTS codex_kind_idx     ON codex_entries(campaign_id, kind);
CREATE INDEX IF NOT EXISTS codex_tags_idx     ON codex_entries USING GIN (tags);
CREATE INDEX IF NOT EXISTS codex_embedding_idx
  ON codex_entries USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS chat_messages (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  author_role   TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invites (
  token         TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  pc_id         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invites_campaign_idx ON invites(campaign_id);

CREATE TABLE IF NOT EXISTS session_summaries (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
