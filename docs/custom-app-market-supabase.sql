-- Supabase SQL for the custom app marketplace.
-- Run this once in the Supabase SQL editor.

create table if not exists public.custom_app_market_apps (
  id text primary key,
  app_id text not null,
  name text not null,
  version text not null default '1.0.0',
  changelog text not null default '',
  description text not null default '',
  icon_data_url text not null default '',
  permissions jsonb not null default '[]'::jsonb,
  manifest jsonb not null default '{}'::jsonb,

  package_url text not null,
  package_path text not null,
  package_kind text not null default 'floatapp' check (package_kind in ('floatapp', 'zip', 'html')),
  package_size integer not null default 0 check (package_size >= 0),

  author_id text not null,
  author_name text not null default '匿名作者',
  author_avatar text not null default '',

  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  install_count integer not null default 0 check (install_count >= 0),
  like_count integer not null default 0 check (like_count >= 0),

  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.custom_app_market_apps
  add column if not exists app_id text not null default '';

alter table public.custom_app_market_apps
  add column if not exists changelog text not null default '';

alter table public.custom_app_market_apps
  add column if not exists icon_data_url text not null default '';

alter table public.custom_app_market_apps
  add column if not exists permissions jsonb not null default '[]'::jsonb;

alter table public.custom_app_market_apps
  add column if not exists manifest jsonb not null default '{}'::jsonb;

alter table public.custom_app_market_apps
  add column if not exists package_url text not null default '';

alter table public.custom_app_market_apps
  add column if not exists package_path text not null default '';

alter table public.custom_app_market_apps
  add column if not exists package_kind text not null default 'floatapp' check (package_kind in ('floatapp', 'zip', 'html'));

alter table public.custom_app_market_apps
  add column if not exists package_size integer not null default 0 check (package_size >= 0);

alter table public.custom_app_market_apps
  add column if not exists review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected'));

alter table public.custom_app_market_apps
  add column if not exists install_count integer not null default 0 check (install_count >= 0);

alter table public.custom_app_market_apps
  add column if not exists like_count integer not null default 0 check (like_count >= 0);

create index if not exists custom_app_market_apps_review_idx
  on public.custom_app_market_apps (review_status, updated_at desc)
  where deleted_at is null;

create index if not exists custom_app_market_apps_author_idx
  on public.custom_app_market_apps (author_id, updated_at desc)
  where deleted_at is null;

create index if not exists custom_app_market_apps_app_id_idx
  on public.custom_app_market_apps (app_id);

create unique index if not exists custom_app_market_apps_app_id_unique_idx
  on public.custom_app_market_apps (app_id)
  where deleted_at is null;

create unique index if not exists custom_app_market_apps_name_unique_idx
  on public.custom_app_market_apps (lower(name))
  where deleted_at is null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'custom-app-market-packages',
  'custom-app-market-packages',
  true,
  5242880,
  array['application/zip', 'application/octet-stream', 'text/html']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.custom_app_market_apps enable row level security;

grant select on public.custom_app_market_apps to anon;

drop policy if exists "custom_app_market_apps_public_read" on public.custom_app_market_apps;
create policy "custom_app_market_apps_public_read"
  on public.custom_app_market_apps
  for select
  to anon
  using (deleted_at is null and review_status = 'approved');

alter table public.custom_app_market_apps replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'custom_app_market_apps'
  ) then
    alter publication supabase_realtime add table public.custom_app_market_apps;
  end if;
end $$;

notify pgrst, 'reload schema';
