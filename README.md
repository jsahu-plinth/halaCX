# HalaCX

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
3. In the OpenAI project webhook settings, send Realtime call events to:

   `https://YOUR_APP_URL/api/openai/incoming`

4. Use an E.164 phone number such as `+971501234567` in the dashboard.

The call endpoint asks Twilio to call the mobile number and bridge it to the OpenAI SIP endpoint. A private context identifier correlates the incoming Realtime event with the correct workspace, agent, knowledge base, and scenario. Signed Twilio callbacks update status and recording metadata. After completion, the server transcribes the recording and stores a structured call summary.

## Verification

```bash
npm run lint
npm run build
npm run backend:verify
```

To verify a deployed build, set `VERIFY_BASE_URL=https://your-domain.example` when running `backend:verify`.

## Production checklist

- Rotate credentials before launch and never commit `.env.local`.
- Configure the OpenAI incoming-call webhook as `https://YOUR_DOMAIN/api/openai/incoming`.
- Configure Google OAuth with `https://YOUR_DOMAIN/api/auth/google/callback`.
- Run the database migration once with `DIRECT_URL`; use the pooled `DATABASE_URL` at runtime.
- Confirm local recording/AI-call consent, retention, and deletion requirements before enabling calls.
- Add abuse controls such as CAPTCHA or phone verification before promoting the public call demo.

Provider credentials remain server-only. OpenAI and Twilio webhook signatures are verified before events are persisted.
