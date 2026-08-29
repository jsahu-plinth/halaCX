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
  call_id uuid references calls(id) on delete cascade,
  context text not null,
  provider_call_id text,
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now()
);

alter table pending_call_contexts add column if not exists call_id uuid references calls(id) on delete cascade;
alter table pending_call_contexts alter column expires_at set default now() + interval '15 minutes';

create table if not exists call_events (
  id bigserial primary key,
  call_id uuid not null references calls(id) on delete cascade,
  provider_event_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table call_events add column if not exists provider_event_id text;

create table if not exists provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text not null,
  event_type text not null,
  provider_call_id text,
  call_id uuid references calls(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'received',
  attempt_count integer not null default 0,
  processing_started_at timestamptz,
  processed_at timestamptz,
  last_error text,
  received_at timestamptz not null default now(),
  unique (provider, event_key),
  check (status in ('received', 'processing', 'processed', 'failed'))
);

create table if not exists demo_requests (
  id bigserial primary key,
  client_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists workspace_connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  toolkit_slug text not null,
  display_name text not null,
  status text not null default 'pending',
  access_level text not null default 'read',
  connected_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, toolkit_slug),
  check (access_level in ('read', 'write'))
);

create index if not exists calls_workspace_created_idx on calls(workspace_id, created_at desc);
create index if not exists knowledge_workspace_idx on knowledge_sources(workspace_id);
create index if not exists pending_context_expiry_idx on pending_call_contexts(expires_at, created_at desc);
create unique index if not exists pending_context_call_idx on pending_call_contexts(call_id) where call_id is not null;
create index if not exists call_events_call_idx on call_events(call_id, created_at);
create unique index if not exists call_events_provider_event_idx on call_events(provider_event_id) where provider_event_id is not null;
create index if not exists demo_requests_client_idx on demo_requests(client_hash, created_at desc);
create index if not exists workspace_connectors_workspace_idx on workspace_connectors(workspace_id, updated_at desc);
create index if not exists provider_webhook_call_idx on provider_webhook_events(provider, provider_call_id, received_at desc);
create index if not exists provider_webhook_status_idx on provider_webhook_events(status, received_at);
