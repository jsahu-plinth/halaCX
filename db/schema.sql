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

-- Distributed media admission. Leases expire automatically so crashed workers do not leak capacity.
create table if not exists media_token_replays (
  token_id text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists media_call_leases (
  lease_id text primary key,
  workspace_id text not null default 'unassigned',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table media_call_leases add column if not exists workspace_id text not null default 'unassigned';

create index if not exists media_token_replays_expiry_idx on media_token_replays(expires_at);
create index if not exists media_call_leases_expiry_idx on media_call_leases(expires_at);
create index if not exists media_call_leases_workspace_idx on media_call_leases(workspace_id, expires_at);

-- Durable asynchronous work queue. Workers claim with SKIP LOCKED and renewable leases.
create table if not exists durable_jobs (
  id uuid primary key default gen_random_uuid(),
  queue text not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'available',
  priority integer not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(queue, dedupe_key),
  check (status in ('available','processing','completed','dead')),
  check (attempt_count >= 0 and max_attempts > 0)
);

create index if not exists durable_jobs_claim_idx on durable_jobs(queue,status,available_at,priority desc,created_at) where status='available';
create index if not exists durable_jobs_lease_idx on durable_jobs(lease_expires_at) where status='processing';

-- Tool Gateway records are deliberately versioned and read-only by default.
-- Enabling connector writes requires a separate migration that changes the
-- tool_policy_versions execution_mode constraint and the application gateway.
create table if not exists tool_capability_versions (
  id uuid primary key default gen_random_uuid(),
  capability_key text not null,
  version integer not null,
  provider_key text not null,
  provider_tool_id text not null,
  toolkit_slug text not null,
  display_name text not null,
  description text not null default '',
  risk_level text not null,
  input_schema jsonb not null default '{}'::jsonb,
  timeout_ms integer not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (capability_key, version),
  check (risk_level in ('read', 'reversible_write', 'external_write', 'sensitive', 'destructive')),
  check (jsonb_typeof(input_schema) = 'object'),
  check (timeout_ms between 100 and 30000),
  check (version > 0)
);

create table if not exists tool_policy_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  version integer not null,
  status text not null default 'draft',
  execution_mode text not null default 'read_only',
  allowed_provider_keys text[] not null default '{}',
  allowed_toolkits text[] not null default '{}',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (workspace_id, version),
  check (status in ('draft', 'published', 'archived')),
  check (execution_mode = 'read_only'),
  check (version > 0)
);

create unique index if not exists tool_policy_one_published_idx
  on tool_policy_versions(workspace_id) where status = 'published';

create table if not exists tool_policy_capabilities (
  policy_version_id uuid not null references tool_policy_versions(id) on delete cascade,
  capability_version_id uuid not null references tool_capability_versions(id) on delete restrict,
  enabled boolean not null default true,
  primary key (policy_version_id, capability_version_id)
);

create table if not exists tool_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,
  agent_id uuid references agents(id) on delete set null,
  capability_version_id uuid not null references tool_capability_versions(id) on delete restrict,
  policy_version_id uuid not null references tool_policy_versions(id) on delete restrict,
  request_id text not null,
  idempotency_key text not null,
  proposal_digest text not null,
  arguments jsonb not null default '{}'::jsonb,
  risk_level text not null,
  status text not null default 'proposed',
  provider_execution_id text,
  result jsonb,
  error jsonb,
  verification_status text not null default 'not_required',
  verification_evidence jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, capability_version_id, idempotency_key),
  check (jsonb_typeof(arguments) = 'object'),
  check (risk_level in ('read', 'reversible_write', 'external_write', 'sensitive', 'destructive')),
  check (status in ('proposed', 'confirmation_required', 'confirmation_verified', 'reserved', 'executing', 'succeeded', 'failed', 'timed_out', 'blocked', 'verification_pending', 'verified', 'verification_failed', 'inconclusive')),
  check (verification_status in ('not_required', 'pending', 'verified', 'failed', 'inconclusive'))
);

create table if not exists tool_confirmation_records (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null unique references tool_executions(id) on delete cascade,
  confirmation_kind text not null,
  status text not null default 'required',
  proposal_digest text not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  proof_type text,
  proof_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (confirmation_kind in ('caller_explicit', 'human_approval')),
  check (status in ('required', 'confirmed', 'rejected', 'expired')),
  check (expires_at > requested_at)
);

create table if not exists tool_idempotency_keys (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scope text not null,
  idempotency_key text not null,
  state text not null default 'in_progress',
  execution_id uuid references tool_executions(id) on delete set null,
  result jsonb,
  lease_owner text not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, scope, idempotency_key),
  check (state in ('in_progress', 'completed')),
  check ((state = 'completed' and result is not null) or state = 'in_progress')
);

create table if not exists tool_audit_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  execution_id uuid not null references tool_executions(id) on delete cascade,
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  actor_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (execution_id, sequence),
  check (sequence > 0),
  check (actor_type in ('system', 'model', 'caller', 'user', 'provider')),
  check (jsonb_typeof(details) = 'object')
);

create index if not exists tool_capability_provider_idx
  on tool_capability_versions(provider_key, toolkit_slug, enabled);
create index if not exists tool_policy_workspace_status_idx
  on tool_policy_versions(workspace_id, status, version desc);
create index if not exists tool_execution_workspace_created_idx
  on tool_executions(workspace_id, created_at desc);
create index if not exists tool_execution_call_idx
  on tool_executions(call_id, created_at) where call_id is not null;
create index if not exists tool_execution_status_idx
  on tool_executions(status, updated_at);
create index if not exists tool_confirmation_status_idx
  on tool_confirmation_records(status, expires_at);
create index if not exists tool_idempotency_lease_idx
  on tool_idempotency_keys(state, lease_expires_at);
create index if not exists tool_audit_workspace_created_idx
  on tool_audit_events(workspace_id, created_at desc);

-- Production RAG foundation. The legacy knowledge_sources table remains the
-- control-plane source record while normalized, immutable versions and chunks
-- are prepared and published independently.
create extension if not exists vector;

alter table knowledge_sources add column if not exists external_id text;
alter table knowledge_sources add column if not exists connector_slug text;
alter table knowledge_sources add column if not exists source_uri text;
alter table knowledge_sources add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table knowledge_sources add column if not exists content_hash text;
alter table knowledge_sources add column if not exists sync_cursor text;
alter table knowledge_sources add column if not exists last_synced_at timestamptz;
alter table knowledge_sources add column if not exists deleted_at timestamptz;
alter table knowledge_sources add column if not exists created_at timestamptz not null default now();

create unique index if not exists knowledge_source_id_workspace_uidx on knowledge_sources(id, workspace_id);
create unique index if not exists knowledge_source_external_uidx
  on knowledge_sources(workspace_id, connector_slug, external_id)
  where connector_slug is not null and external_id is not null and deleted_at is null;

create table if not exists knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_id uuid,
  external_id text not null,
  title text not null,
  source_uri text,
  mime_type text,
  language text,
  access_scope text not null default 'workspace',
  metadata jsonb not null default '{}'::jsonb,
  current_version integer not null default 0,
  status text not null default 'pending',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (source_id, workspace_id) references knowledge_sources(id, workspace_id) on delete cascade,
  check (access_scope in ('workspace', 'restricted')),
  check (status in ('pending', 'indexing', 'ready', 'failed', 'deleted')),
  check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists knowledge_document_external_uidx
  on knowledge_documents(
    workspace_id,
    coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
    external_id
  )
  where deleted_at is null;
create index if not exists knowledge_document_workspace_status_idx
  on knowledge_documents(workspace_id, status, updated_at desc)
  where deleted_at is null;

create table if not exists knowledge_document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null,
  version integer not null,
  content_hash text not null,
  parser_version text not null,
  embedding_model text not null,
  embedding_dimensions integer not null default 1536,
  status text not null default 'processing',
  chunk_count integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_id, version),
  unique (id, document_id, workspace_id),
  unique (document_id, content_hash),
  foreign key (document_id, workspace_id) references knowledge_documents(id, workspace_id) on delete cascade,
  check (version > 0),
  check (embedding_dimensions = 1536),
  check (status in ('processing', 'ready', 'failed', 'superseded')),
  check (chunk_count >= 0)
);

create index if not exists knowledge_version_workspace_status_idx
  on knowledge_document_versions(workspace_id, status, created_at desc);

create table if not exists knowledge_document_acl (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null,
  principal_type text not null,
  principal_id text not null,
  permission text not null default 'read',
  created_at timestamptz not null default now(),
  primary key (workspace_id, document_id, principal_type, principal_id),
  foreign key (document_id, workspace_id) references knowledge_documents(id, workspace_id) on delete cascade,
  check (principal_type in ('user', 'role', 'group')),
  check (permission = 'read')
);

create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null,
  version_id uuid not null,
  source_id uuid,
  ordinal integer not null,
  content text not null,
  content_search tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored,
  embedding vector(1536),
  token_count integer not null,
  heading_path text[] not null default '{}',
  page_start integer,
  page_end integer,
  char_start integer,
  char_end integer,
  citation_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (version_id, ordinal),
  foreign key (version_id, document_id, workspace_id)
    references knowledge_document_versions(id, document_id, workspace_id) on delete cascade,
  foreign key (source_id, workspace_id) references knowledge_sources(id, workspace_id) on delete cascade,
  check (ordinal >= 0),
  check (length(content) between 1 and 20000),
  check (token_count > 0),
  check (page_start is null or page_start > 0),
  check (page_end is null or page_end >= page_start),
  check (char_start is null or char_start >= 0),
  check (char_end is null or char_end >= char_start),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists knowledge_chunk_workspace_document_idx
  on knowledge_chunks(workspace_id, document_id, version_id, ordinal);
create index if not exists knowledge_chunk_source_idx
  on knowledge_chunks(workspace_id, source_id) where source_id is not null;
create index if not exists knowledge_chunk_lexical_idx
  on knowledge_chunks using gin(content_search);
create index if not exists knowledge_chunk_embedding_hnsw_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create table if not exists knowledge_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_id uuid,
  document_id uuid,
  idempotency_key text not null,
  requested_version integer,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (source_id, workspace_id) references knowledge_sources(id, workspace_id) on delete cascade,
  foreign key (document_id, workspace_id) references knowledge_documents(id, workspace_id) on delete cascade,
  check (status in ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  check (attempt_count >= 0),
  check (requested_version is null or requested_version > 0),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists knowledge_ingestion_claim_idx
  on knowledge_ingestion_jobs(status, available_at, created_at)
  where status in ('queued', 'failed');

create table if not exists knowledge_index_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  version bigint not null,
  embedding_model text not null,
  embedding_dimensions integer not null default 1536,
  parser_version text not null,
  status text not null default 'building',
  document_count integer not null default 0,
  chunk_count bigint not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, version),
  check (version > 0),
  check (embedding_dimensions = 1536),
  check (status in ('building', 'published', 'retired', 'failed')),
  check (document_count >= 0),
  check (chunk_count >= 0)
);

create unique index if not exists knowledge_index_one_published_idx
  on knowledge_index_versions(workspace_id)
  where status = 'published';

create table if not exists knowledge_retrieval_traces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,
  request_id text not null,
  query_hash text not null,
  locale text,
  index_version bigint,
  candidate_count integer not null default 0,
  result_count integer not null default 0,
  dense_latency_ms integer,
  lexical_latency_ms integer,
  rerank_latency_ms integer,
  total_latency_ms integer,
  selected_chunk_ids uuid[] not null default '{}',
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, request_id),
  check (candidate_count >= 0),
  check (result_count >= 0),
  check (jsonb_typeof(diagnostics) = 'object')
);

create index if not exists knowledge_retrieval_trace_workspace_idx
  on knowledge_retrieval_traces(workspace_id, created_at desc);

create table if not exists phone_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  provider text not null default 'twilio',
  provider_number_id text not null,
  phone_number text not null unique,
  friendly_name text,
  country_code text,
  status text not null default 'provisioning',
  inbound_enabled boolean not null default true,
  scenario text not null default 'receptionist',
  voice_provider text not null default 'openai',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_number_id),
  check (status in ('provisioning','active','failed','suspended')),
  check (scenario in ('receptionist','appointment','lead','support')),
  check (voice_provider in ('openai','sarvam','cartesia'))
);

create index if not exists phone_numbers_workspace_idx on phone_numbers(workspace_id, created_at);
create index if not exists phone_numbers_inbound_route_idx on phone_numbers(phone_number) where status='active' and inbound_enabled=true;
