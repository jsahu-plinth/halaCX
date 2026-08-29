# HalaCX

## Agentic connectors

HalaCX uses the MIT-licensed Composio SDK as its connector gateway. Each customer workspace maps to a separate external user identity, so OAuth connections and tool access do not cross tenants. Notion, Google Drive, Google Calendar, Gmail, and Google Sheets are available in the dashboard.

The live voice worker exposes the same two-function contract to every supported model: search for an appropriate connected tool, then execute that tool. Current connector sessions are filtered to Composio's `readOnlyHint` tools. Write actions are intentionally disabled until a confirmation and audit policy is added.

Set `COMPOSIO_API_KEY` in both the web deployment and the Railway voice worker, run `npm run db:migrate`, then connect apps from the dashboard.

`lib/tools` now defines a provider-neutral gateway boundary. Only catalogued, schema-valid, workspace-allowed read capabilities may execute. Write capabilities remain blocked until durable confirmation, policy, audit, idempotency, and authoritative verification stores are connected.

A multilingual AI call-center platform built with Next.js, PostgreSQL/Supabase, Twilio Voice, and OpenAI Realtime. HalaCX includes account authentication, workspace and agent configuration, a knowledge base, outbound demo calls, signed provider webhooks, and a call dashboard with recordings, transcripts, summaries, and outcomes.

## Run the interface

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local`, supply the required values, run `npm run db:migrate`, then open `http://localhost:3000`.

## Connect real calls

1. Copy `.env.example` to `.env.local` and fill in the OpenAI and Twilio values. Prefer a Twilio API Key SID and secret. The Account SID is still required because it identifies the account in the Calls API URL.
2. Set `APP_URL` to the exact public HTTPS origin. For production, use the stable deployment URL rather than a temporary tunnel.
3. Generate a random `MEDIA_STREAM_SECRET` of at least 32 characters and configure the identical value in the web deployment and every voice-worker deployment.
4. In the OpenAI project webhook settings, send Realtime call events to:

   `https://YOUR_APP_URL/api/openai/incoming`

5. Use an E.164 phone number such as `+971501234567` in the dashboard.

The call endpoint asks Twilio to call the mobile number and stream media to the persistent voice worker. An expiring signed admission token is validated before the worker opens a paid model or speech connection. A private context identifier correlates the call with the correct workspace, agent, knowledge, and scenario. Signed Twilio callbacks are persisted idempotently and reduced through a monotonic call-state transition. Recording callbacks are deduplicated before post-call transcription and analysis.

Post-call processing currently uses Next.js `after()` as an intermediate asynchronous step. A durable queue and recovery worker are still required before high-volume production.

## Verification

```bash
npm run lint
npm run build
npm test
npm run backend:verify
```

To verify a deployed build, set `VERIFY_BASE_URL=https://your-domain.example` when running `backend:verify`.

## Production checklist

- Rotate credentials before launch and never commit `.env.local`.
- Configure the same `MEDIA_STREAM_SECRET` in the web and voice-worker deployments.
- Configure the OpenAI incoming-call webhook as `https://YOUR_DOMAIN/api/openai/incoming`.
- Configure Google OAuth with `https://YOUR_DOMAIN/api/auth/google/callback`.
- Run the database migration once with `DIRECT_URL`; use the pooled `DATABASE_URL` at runtime.
- Confirm local recording/AI-call consent, retention, and deletion requirements before enabling calls.
- Add abuse controls such as CAPTCHA or phone verification before promoting the public call demo.

Provider credentials remain server-only. OpenAI and Twilio webhook signatures are verified before events are persisted.
