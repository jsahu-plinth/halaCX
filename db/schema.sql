create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'owner',
  primary key (workspace_id, user_id)
);

create table if not exists oauth_accounts (
  provider text not null,
  provider_account_id text not null,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, provider_account_id),
  unique (provider, user_id)
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null default 'Maya',
  status text not null default 'ready',
  voice text not null default 'marin',
  languages text[] not null default array['English','Arabic'],
  instructions text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  content text not null default '',
  source_type text not null default 'text',
  status text not null default 'active',
  updated_at timestamptz not null default now()
);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  provider_call_id text unique,
  openai_call_id text unique,
  direction text not null,
  from_number text,
  to_number text,
  caller_name text,
  status text not null default 'queued',
  outcome text,
  summary text,
  transcript jsonb not null default '[]'::jsonb,
  recording_url text,
  duration_seconds integer,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

alter table calls add column if not exists openai_call_id text unique;

create table if not exists pending_call_contexts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  context text not null,
  provider_call_id text,
  expires_at timestamptz not null default now() + interval '2 minutes',
  created_at timestamptz not null default now()
);

create table if not exists call_events (
  id bigserial primary key,
  call_id uuid not null references calls(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists demo_requests (
  id bigserial primary key,
  client_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists calls_workspace_created_idx on calls(workspace_id, created_at desc);
create index if not exists knowledge_workspace_idx on knowledge_sources(workspace_id);
create index if not exists pending_context_expiry_idx on pending_call_contexts(expires_at, created_at desc);
create index if not exists call_events_call_idx on call_events(call_id, created_at);
create index if not exists demo_requests_client_idx on demo_requests(client_hash, created_at desc);
