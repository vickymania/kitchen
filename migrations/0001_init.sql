-- Phase 1: the household, its people and devices, recipes, and the shared list.
--
-- Every row a phone can see carries `rev`: the household's change counter at
-- the moment the row last changed. A phone asks "everything with rev > N" and
-- is up to date. Deleting sets deleted_at instead of removing the row, so the
-- other phones hear about it.

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'nl',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX members_rev ON members(household_id, rev);

-- A device holds a long random token in a cookie (or a Bearer header for
-- tools); only its SHA-256 is stored here.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

-- A six-digit code someone types, or a one-time link from the other app.
-- Either pairs one device to an existing member, or creates a new member.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL DEFAULT 'code',
  member_id TEXT REFERENCES members(id),
  new_member_name TEXT,
  make_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Wrong codes per address per day, and for everyone per day.
CREATE TABLE pairing_failures (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  title TEXT NOT NULL,
  servings INTEGER,
  ingredients TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  nutrition TEXT,
  photo TEXT,
  source_url TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX recipes_rev ON recipes(household_id, rev);

-- What you buy, independent of brand: "ui", "gehakt", "waspods". An
-- ingredient and a list line point at the same item. Phase 2 hangs preferred
-- products and ratings on it.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX items_name ON items(household_id, name_key);
CREATE INDEX items_rev ON items(household_id, rev);

CREATE TABLE list_entries (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT REFERENCES items(id),
  title TEXT NOT NULL,
  amounts TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  added_by TEXT,
  checked_at TEXT,
  checked_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX list_entries_rev ON list_entries(household_id, rev);
-- One open line per item. The op engine merges instead; this is the net
-- under it for two phones adding the same thing at the same moment.
CREATE UNIQUE INDEX list_entries_open_item ON list_entries(household_id, item_id)
  WHERE item_id IS NOT NULL AND checked_at IS NULL AND deleted_at IS NULL;

-- Ops already applied, so a phone that retries after a lost answer does not
-- apply the same change twice.
CREATE TABLE applied_ops (
  op_id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  result TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
