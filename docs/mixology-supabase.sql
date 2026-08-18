-- Supabase SQL for House Special (mixology): the materials page, the hall, and social.
-- Run this once in the Supabase SQL editor.
--
-- mixology_items    materials page: shared materials (eleven kinds; payload is the full
--                   material JSON)
-- mixology_recipes  hall: shared blends. `materials` holds an array of SLOT REFERENCES and
--                   never embeds the material itself. A reference looks like
--                   {id,kind,name,builtin?,when?}; the same kind may appear several times (a
--                   slot stacking several materials, in array order), and `when` is that one's
--                   condition. `materials` is jsonb, so adding these fields needed no schema
--                   change.
-- mixology_likes / mixology_saves / mixology_comments
--                   likes / saves to the cabinet / threaded comments, with target_type telling
--                   materials and blends apart

create table if not exists public.mixology_items (
  id text primary key,

  kind text not null check (kind in ('character', 'persona', 'base', 'flavor', 'glass', 'strength', 'ticket', 'garnish', 'encore', 'filter', 'mechanism')),
  name text not null,
  hook text not null default '',
  cover text not null default '',
  tags jsonb not null default '[]'::jsonb,
  payload jsonb not null,

  author_id text not null default 'anonymous',
  author_name text not null default 'Anonymous bartender',
  author_avatar text not null default '',

  like_count integer not null default 0 check (like_count >= 0),
  save_count integer not null default 0 check (save_count >= 0),
  view_count integer not null default 0 check (view_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mixology_items_kind_idx
  on public.mixology_items (kind, updated_at desc)
  where deleted_at is null;

create index if not exists mixology_items_author_idx
  on public.mixology_items (author_id, updated_at desc)
  where deleted_at is null;

create index if not exists mixology_items_tags_idx
  on public.mixology_items using gin (tags);

create table if not exists public.mixology_recipes (
  id text primary key,

  name text not null,
  intro text not null default '',
  cover text not null default '',
  char_name text not null default '',
  part_names jsonb not null default '[]'::jsonb,
  materials jsonb not null,

  author_id text not null default 'anonymous',
  author_name text not null default 'Anonymous bartender',
  author_avatar text not null default '',

  like_count integer not null default 0 check (like_count >= 0),
  save_count integer not null default 0 check (save_count >= 0),
  view_count integer not null default 0 check (view_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mixology_recipes_updated_idx
  on public.mixology_recipes (updated_at desc)
  where deleted_at is null;

create index if not exists mixology_recipes_author_idx
  on public.mixology_recipes (author_id, updated_at desc)
  where deleted_at is null;

create table if not exists public.mixology_likes (
  target_type text not null check (target_type in ('material', 'recipe')),
  target_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (target_type, target_id, user_id)
);

create index if not exists mixology_likes_user_idx
  on public.mixology_likes (user_id, created_at desc);

create table if not exists public.mixology_saves (
  target_type text not null check (target_type in ('material', 'recipe')),
  target_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (target_type, target_id, user_id)
);

create index if not exists mixology_saves_user_idx
  on public.mixology_saves (user_id, created_at desc);

create table if not exists public.mixology_comments (
  id text primary key,
  target_type text not null check (target_type in ('material', 'recipe')),
  target_id text not null,
  parent_id text references public.mixology_comments(id) on delete cascade,
  author_id text not null,
  author_name text not null default 'Anonymous guest',
  content text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mixology_comments_target_idx
  on public.mixology_comments (target_type, target_id, created_at asc)
  where deleted_at is null;

create index if not exists mixology_comments_parent_idx
  on public.mixology_comments (target_id, parent_id, created_at asc)
  where deleted_at is null;

alter table public.mixology_items enable row level security;
alter table public.mixology_recipes enable row level security;
alter table public.mixology_likes enable row level security;
alter table public.mixology_saves enable row level security;
alter table public.mixology_comments enable row level security;

-- Revoke direct anon reads. payload/materials are a creator's complete card and blend source,
-- and leaving anon open lets anyone with the anon key bypass the in-app API and scrape them in
-- bulk.
-- Every read and write in the app goes through the Next API with the service key, so nothing
-- depends on a direct anon connection.
revoke select on public.mixology_items from anon;
revoke select on public.mixology_recipes from anon;
revoke select on public.mixology_likes from anon;
revoke select on public.mixology_saves from anon;
revoke select on public.mixology_comments from anon;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────
-- Upgrading an existing database (run this section only; safe to run repeatedly, and running
-- it through once brings the schema fully up to date):
--  1) widen the kind check constraint to all eleven: persona (mask), filter (strainer),
--     mechanism
--  2) creator avatars: add an author_avatar column to both tables
--
-- Note: a blend's materials column was already jsonb, and "several materials per slot, each
-- with its own condition" only adds fields inside that JSON -- no schema change was needed, so
-- there is no matching alter here.
alter table public.mixology_items drop constraint if exists mixology_items_kind_check;
alter table public.mixology_items
  add constraint mixology_items_kind_check
  check (kind in ('character', 'persona', 'base', 'flavor', 'glass', 'strength', 'ticket', 'garnish', 'encore', 'filter', 'mechanism'));
alter table public.mixology_items add column if not exists author_avatar text not null default '';
alter table public.mixology_recipes add column if not exists author_avatar text not null default '';
notify pgrst, 'reload schema';
