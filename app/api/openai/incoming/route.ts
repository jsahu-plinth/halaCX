import { after, NextResponse } from "next/server";
import OpenAI from "openai";
import WebSocket from "ws";
import { consumePendingCallContext, contextInstructions } from "@/lib/call-context";
import { isDatabaseConfigured, query } from "@/lib/db";

export const maxDuration = 300;

async function startGreeting(callId: string, agentName: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        origin: "https://api.openai.com",
      },
    });
    const connectionTimeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("Realtime greeting connection timed out"));
    }, 15_000);
    const callTimeout = setTimeout(() => socket.close(1000, "Call worker time limit"), 280_000);

    socket.once("open", () => {
      clearTimeout(connectionTimeout);
      console.info("OpenAI Realtime sideband opened", { callId });
      socket.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions: `Introduce yourself as ${agentName} from HalaCX, welcome the caller warmly, and ask how you can help. Keep the greeting brief and match the caller's language once they respond.`,
        },
      }));
    });
    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as { type?: string; error?: { message?: string } };
        if (["session.created", "response.created", "response.done"].includes(event.type || "")) {
          console.info("OpenAI Realtime event", { callId, type: event.type });
        }
        if (event.type === "error") throw new Error(event.error?.message || "Realtime call failed");
      } catch (error) {
        clearTimeout(connectionTimeout);
        clearTimeout(callTimeout);
        socket.terminate();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(connectionTimeout);
      clearTimeout(callTimeout);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(connectionTimeout);
      clearTimeout(callTimeout);
      console.info("OpenAI Realtime sideband closed", { callId });
      resolve();
    });
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  let event: { type?: string; data?: { call_id?: string; session_id?: string; sip_headers?: Array<{ name?: string; value?: string }> } };

  try {
    if (!process.env.OPENAI_WEBHOOK_SECRET) throw new Error("Webhook secret is not configured");
    if (!request.headers.get("webhook-id") || !request.headers.get("webhook-timestamp") || !request.headers.get("webhook-signature")) {
      throw new Error("Webhook signature headers are missing");
    }
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
    });
    event = client.webhooks.unwrap(rawBody, request.headers) as typeof event;
  } catch (error) {
    console.error("Invalid OpenAI webhook", error);
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  if (event.type !== "realtime.call.incoming") {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const callId = event?.data?.call_id || event?.data?.session_id;
  if (!callId || !process.env.OPENAI_API_KEY) return NextResponse.json({ ok: false }, { status: 400 });

  const webhookKey = request.headers.get("webhook-id")!;
  let inboxId: string | null = null;
  if (isDatabaseConfigured) {
    await query(
      `insert into provider_webhook_events(provider,event_key,event_type,provider_call_id,payload)
       values('openai',$1,'realtime.call.incoming',$2,$3::jsonb)
       on conflict(provider,event_key) do nothing`,
      [webhookKey, callId, JSON.stringify(event)],
    );
    const claimed = await query<{ id: string }>(
      `update provider_webhook_events
       set status='processing',processing_started_at=now(),attempt_count=attempt_count+1,last_error=null
       where provider='openai' and event_key=$1
         and (status in ('received','failed') or (status='processing' and processing_started_at<now()-interval '5 minutes'))
       returning id`,
      [webhookKey],
    );
    if (!claimed.rows[0]) return NextResponse.json({ ok: true, duplicate: true });
    inboxId = claimed.rows[0].id;
  }

  try {
    const contextHeader = event.data?.sip_headers?.find((header) => header.name?.toLowerCase() === "x-halacx-context")?.value;
    const pending = await consumePendingCallContext(contextHeader);
    let agent = { name: "Maya", voice: "marin", instructions: "Welcome every caller, answer from approved knowledge, and offer a human follow-up when needed." };
    let knowledge = process.env.RECEPTIONIST_KNOWLEDGE ?? "No workspace knowledge is available. Collect a message instead of inventing an answer.";
    if (isDatabaseConfigured && pending.workspaceId) {
      const [agentResult, knowledgeResult] = await Promise.all([
        query<{ name: string; voice: string; instructions: string }>("select name,voice,instructions from agents where workspace_id=$1 order by created_at limit 1", [pending.workspaceId]),
        query<{ content: string }>("select content from knowledge_sources where workspace_id=$1 and status='active' order by updated_at desc limit 30", [pending.workspaceId]),
      ]);
      if (agentResult.rows[0]) agent = agentResult.rows[0];
      if (knowledgeResult.rows.length) knowledge = knowledgeResult.rows.map((row) => row.content).join("\n\n").slice(0, 40_000);
      const bound = pending.callId
        ? await query<{ id: string }>(
            "update calls set openai_call_id=$1 where id=$2 and workspace_id=$3 and (openai_call_id is null or openai_call_id=$1) returning id",
            [callId, pending.callId, pending.workspaceId],
          )
        : await query<{ id: string }>(
            "update calls set openai_call_id=$1 where provider_call_id=$2 and workspace_id=$3 and (openai_call_id is null or openai_call_id=$1) returning id",
            [callId, pending.providerCallId, pending.workspaceId],
          );
      if (!bound.rows[0]) {
        if (inboxId) await query("update provider_webhook_events set status='failed',processing_started_at=null,last_error='Call context is already bound to another realtime call' where id=$1", [inboxId]);
        return NextResponse.json({ error: "Call context could not be bound" }, { status: 409 });
      }
      if (inboxId) await query("update provider_webhook_events set call_id=$1 where id=$2", [bound.rows[0].id, inboxId]);
    }
    const scenario = contextInstructions(pending.context);
    const response = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "realtime",
        model: "gpt-realtime-2.1",
        instructions: `You are ${agent.name}, a warm, concise multilingual contact-center agent powered by HalaCX. Start by introducing yourself and asking whether now is a good time. Match the caller's language when possible. Never invent business facts. ${agent.instructions} ${scenario} Ask for the caller's name and preferred follow-up when appropriate. Approved business knowledge: ${knowledge}`,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("OpenAI call acceptance failed", response.status, detail.slice(0, 1_000));
      if (inboxId) await query("update provider_webhook_events set status='failed',processing_started_at=null,last_error=$1 where id=$2", [detail.slice(0, 2_000), inboxId]);
      return NextResponse.json({ ok: false }, { status: 502 });
    }
    console.info("OpenAI SIP call accepted", {
      callId,
      requestId: response.headers.get("x-request-id") || "",
    });

    if (inboxId) {
      await query("update provider_webhook_events set status='processed',processed_at=now(),processing_started_at=null,last_error=null where id=$1", [inboxId]);
      if (pending.callId) {
        await query(
          `insert into call_events(call_id,provider_event_id,event_type,payload)
           values($1,$2,'openai.realtime.incoming',$3::jsonb)
           on conflict(provider_event_id) where provider_event_id is not null do nothing`,
          [pending.callId, `openai:${webhookKey}`, JSON.stringify({ callId, requestId: response.headers.get("x-request-id") || "" })],
        );
      }
    }

    after(async () => {
      try {
        await startGreeting(callId, agent.name);
      } catch (error) {
        console.error("OpenAI greeting failed", error);
      }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown incoming call error";
    if (inboxId) await query("update provider_webhook_events set status='failed',processing_started_at=null,last_error=$1 where id=$2", [message.slice(0, 2_000), inboxId]);
    console.error("OpenAI incoming call processing failed", { callId, message });
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
