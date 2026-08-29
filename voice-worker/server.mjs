import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";
import { Composio } from "@composio/core";
import { assertMediaTokenBinding, BoundedQueue, verifyMediaToken } from "./security.mjs";
import { createAdmissionStore } from "./admission.mjs";

const { Pool } = pg;
function positiveIntegerEnv(name, fallback, minimum = 1) {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

const port = Number(process.env.PORT || 8080);
const apiKey = process.env.OPENAI_API_KEY;
const voiceProvider = process.env.VOICE_PROVIDER || "openai";
const cartesiaApiKey = process.env.CARTESIA_API_KEY;
const cartesiaVoiceId = process.env.CARTESIA_VOICE_ID || "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
const sarvamApiKey = process.env.SARVAM_API_KEY;
const sarvamSpeaker = process.env.SARVAM_SPEAKER || "priya";
const sarvamLanguage = process.env.SARVAM_LANGUAGE || "hi-IN";
const sarvamSttModel = process.env.SARVAM_STT_MODEL || "saaras:v3";
const sarvamChatModel = process.env.SARVAM_CHAT_MODEL || "sarvam-105b-conversations";
const databaseUrl = process.env.DATABASE_URL;
const composioApiKey = process.env.COMPOSIO_API_KEY;
const mediaStreamSecret = process.env.MEDIA_STREAM_SECRET;
const appUrl = process.env.APP_URL?.replace(/\/$/, "");
const internalJobSecret = process.env.INTERNAL_JOB_SECRET;
const maxActiveCalls = positiveIntegerEnv("MAX_ACTIVE_CALLS", 250);
const maxGlobalActiveCalls = positiveIntegerEnv("MAX_GLOBAL_ACTIVE_CALLS", 10_000);
const maxWorkspaceActiveCalls = positiveIntegerEnv("MAX_WORKSPACE_ACTIVE_CALLS", 100);
const maxPendingMediaConnections = positiveIntegerEnv("MAX_PENDING_MEDIA_CONNECTIONS", 25);
const maxFrameBytes = positiveIntegerEnv("MAX_MEDIA_FRAME_BYTES", 65_536, 4_096);
const providerConnectTimeoutMs = positiveIntegerEnv("PROVIDER_CONNECT_TIMEOUT_MS", 10_000, 1_000);
const startTimeoutMs = positiveIntegerEnv("MEDIA_START_TIMEOUT_MS", 5_000, 1_000);
const composio = composioApiKey ? new Composio({ apiKey: composioApiKey }) : null;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, ssl: { rejectUnauthorized: false } }) : null;
const admissionStore = createAdmissionStore({ pool, redisUrl: process.env.UPSTASH_REDIS_REST_URL, redisToken: process.env.UPSTASH_REDIS_REST_TOKEN, namespace: process.env.ADMISSION_NAMESPACE });

if (!mediaStreamSecret || mediaStreamSecret.length < 32) throw new Error("MEDIA_STREAM_SECRET (at least 32 characters) is required");
if (!["openai", "sarvam", "cartesia"].includes(voiceProvider)) throw new Error("VOICE_PROVIDER must be openai, sarvam, or cartesia");
if (voiceProvider === "cartesia" && !cartesiaApiKey) throw new Error("CARTESIA_API_KEY is required when VOICE_PROVIDER=cartesia");
if (voiceProvider === "sarvam" && !sarvamApiKey) throw new Error("SARVAM_API_KEY is required when VOICE_PROVIDER=sarvam");

const scenarios = {
  receptionist: "Act as a front-desk receptionist. Answer questions, capture the caller's name and message, and offer a human follow-up when needed.",
  appointment: "Act as an appointment coordinator. Ask what service is needed, confirm the preferred time, and summarize the request.",
  lead: "Act as a helpful lead qualification agent. Ask about the caller's company, need, urgency, and preferred next step.",
  support: "Act as a customer-support agent. Ask for the issue and reference number, explain the next action, and escalate when human judgment is needed."
};

let draining = false;
let activeCalls = 0;
let pendingMediaConnections = 0;
let admissionHealthy = false;
let jobPollTimer = null;

function log(level, event, fields = {}) {
  const entry = { timestamp: new Date().toISOString(), level, event, ...fields };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else console.log(output);
}

pool?.on("error", error => log("error", "database_pool_error", { message: error.message }));

async function refreshAdmissionHealth() {
  try { admissionHealthy = await admissionStore.healthCheck(); }
  catch (error) {
    admissionHealthy = false;
    log("error", "admission_health_failed", { message: error.message });
  }
}

await refreshAdmissionHealth();
const admissionHealthTimer = setInterval(() => void refreshAdmissionHealth(), 10_000);
admissionHealthTimer.unref();

async function pollInternalJobs() {
  if (draining || !appUrl || !internalJobSecret) return;
  let delayMs = 2_000;
  try {
    for (const path of ["/api/internal/jobs/sweep", "/api/internal/jobs/post-call"]) {
      const response = await fetch(`${appUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${internalJobSecret}` },
        signal: AbortSignal.timeout(path.endsWith("post-call") ? 310_000 : 15_000),
      });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      const result = await response.json();
      if (path.endsWith("post-call") && Number(result.claimed || 0) > 0) delayMs = 100;
    }
  } catch (error) {
    delayMs = 10_000;
    log("error", "internal_job_poll_failed", { message: error.message });
  } finally {
    if (!draining) {
      jobPollTimer = setTimeout(() => void pollInternalJobs(), delayMs);
      jobPollTimer.unref();
    }
  }
}

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) return socket.destroy();
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function mulawToPcm16(base64) {
  const input = Buffer.from(base64, "base64");
  const output = Buffer.allocUnsafe(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const value = ~input[index] & 0xff;
    const sign = value & 0x80;
    const exponent = (value >> 4) & 0x07;
    const mantissa = value & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample = sign ? 0x84 - sample : sample - 0x84;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return output.toString("base64");
}

async function loadContext(contextId, fallbackScenario) {
  const base = {
    name: "Maya",
    voice: "coral",
    scenario: fallbackScenario in scenarios ? fallbackScenario : "receptionist",
    instructions: "Be warm, natural, multilingual, and never invent business facts.",
    knowledge: process.env.RECEPTIONIST_KNOWLEDGE || "No approved business knowledge is available. Collect a message instead of guessing.",
    workspaceId: "",
    connectorToolkits: []
  };
  if (!pool || !contextId) return base;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pending = await client.query("select workspace_id,context,provider_call_id,call_id from pending_call_contexts where id=$1 and expires_at>now()", [contextId]);
    const row = pending.rows[0];
    if (!row?.workspace_id) { await client.query("commit"); return { ...base, scenario: row?.context || base.scenario }; }
    const [agent, knowledge, connectors] = await Promise.all([
      client.query("select name,voice,instructions from agents where workspace_id=$1 order by created_at limit 1", [row.workspace_id]),
      client.query("select content from knowledge_sources where workspace_id=$1 and status='active' order by updated_at desc limit 30", [row.workspace_id]),
      client.query("select toolkit_slug from workspace_connectors where workspace_id=$1 and status='connected' and access_level='read' order by toolkit_slug", [row.workspace_id])
    ]);
    await client.query("commit");
    return {
      ...base,
      ...agent.rows[0],
      workspaceId: row.workspace_id,
      scenario: row.context || base.scenario,
      knowledge: knowledge.rows.length ? knowledge.rows.map(item => item.content).join("\n\n").slice(0, 40000) : base.knowledge,
      connectorToolkits: connectors.rows.map(item => item.toolkit_slug)
    };
  } catch (error) {
    await client.query("rollback");
    log("error", "context_load_failed", { contextId, message: error.message });
    return base;
  } finally {
    client.release();
  }
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/live" || pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, activeCalls, pendingMediaConnections, draining }));
    return;
  }
  if (pathname === "/ready") {
    const ready = !draining && admissionHealthy && activeCalls < maxActiveCalls;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: ready, activeCalls, pendingMediaConnections, capacity: maxActiveCalls, draining }));
    return;
  }
  response.writeHead(404).end();
});

const twilioServer = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/twilio-media") return rejectUpgrade(socket, "404 Not Found", "Not found");
  if (draining) return rejectUpgrade(socket, "503 Service Unavailable", "Worker is draining");
  if (activeCalls >= maxActiveCalls) return rejectUpgrade(socket, "503 Service Unavailable", "Worker is at capacity");
  if (pendingMediaConnections >= maxPendingMediaConnections) return rejectUpgrade(socket, "503 Service Unavailable", "Too many pending media connections");
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    try {
      request.mediaTokenPayload = verifyMediaToken(queryToken, mediaStreamSecret);
    } catch (error) {
      log("warn", "media_upgrade_rejected", { reason: error.message, remoteAddress: request.socket.remoteAddress });
      return rejectUpgrade(socket, "401 Unauthorized", "Invalid media token");
    }
  }
  twilioServer.handleUpgrade(request, socket, head, ws => twilioServer.emit("connection", ws, request));
});

twilioServer.on("connection", (twilio, request) => {
  activeCalls += 1;
  pendingMediaConnections += 1;
  const callTraceId = randomUUID();
  let selectedVoiceProvider = voiceProvider;
  let streamSid = "";
  let callSid = "";
  let workspaceId = "";
  let openai = null;
  let cartesia = null;
  let sarvam = null;
  let sarvamStt = null;
  let ready = false;
  let greetingSent = false;
  let cartesiaContextId = "";
  let sarvamGeneration = 0;
  let sarvamSpeaking = false;
  let sarvamTextBuffer = "";
  let sarvamReplyController = null;
  let sarvamMessages = [];
  let sarvamSystemPrompt = "";
  let connectorSession = null;
  let authenticated = false;
  let admissionInProgress = false;
  let leaseAcquired = false;
  let leaseRenewal = null;
  let leaseRenewalFailures = 0;
  let pendingAdmission = true;
  let closed = false;
  let tokenPayload = request.mediaTokenPayload || null;
  const bufferedAudio = new BoundedQueue({ maxItems: 500, maxBytes: 2 * 1024 * 1024 });
  const cartesiaQueue = new BoundedQueue({ maxItems: 100, maxBytes: 512 * 1024 });
  const sarvamQueue = new BoundedQueue({ maxItems: 100, maxBytes: 512 * 1024 });
  const providerTimers = new Set();
  const startTimer = setTimeout(() => failCall("media_start_timeout", 1008), startTimeoutMs);

  function callLog(level, event, fields = {}) {
    log(level, event, { callTraceId, callSid: callSid || undefined, streamSid: streamSid || undefined, provider: selectedVoiceProvider, ...fields });
  }

  function closeSocket(socket, code, reason) {
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) socket.close(code, reason);
  }

  function clearProviderTimers() {
    for (const timer of providerTimers) clearTimeout(timer);
    providerTimers.clear();
  }

  function armProviderTimeout(socket, provider) {
    const timer = setTimeout(() => {
      providerTimers.delete(timer);
      callLog("error", "provider_connect_timeout", { targetProvider: provider });
      closeSocket(socket, 1013, "Provider connection timeout");
      failCall("provider_unavailable", 1013);
    }, providerConnectTimeoutMs);
    providerTimers.add(timer);
    socket.once("open", () => { clearTimeout(timer); providerTimers.delete(timer); });
    socket.once("close", () => { clearTimeout(timer); providerTimers.delete(timer); });
  }

  async function withDeadline(promise, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), providerConnectTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function failCall(reason, code = 1011) {
    if (closed) return;
    callLog("error", "call_failed", { reason });
    closeSocket(twilio, code, reason.slice(0, 120));
    closeSocket(openai, 1011, reason);
    closeSocket(cartesia, 1011, reason);
    closeSocket(sarvam, 1011, reason);
    closeSocket(sarvamStt, 1011, reason);
  }

  async function renewAdmissionLease() {
    try {
      const renewed = await admissionStore.renew(callTraceId, 90_000, workspaceId);
      if (!renewed) failCall("admission_lease_lost", 1013);
      else leaseRenewalFailures = 0;
    } catch (error) {
      leaseRenewalFailures += 1;
      callLog("error", "admission_lease_renewal_failed", { message: error.message });
      if (leaseRenewalFailures >= 2) failCall("admission_lease_unavailable", 1013);
    }
  }

  function queueOrFail(queue, value, name) {
    if (queue.push(value)) return true;
    callLog("error", "queue_overflow", { queue: name, queuedItems: queue.length });
    failCall(`${name}_overflow`, 1009);
    return false;
  }

  function parseFrame(raw, source) {
    try {
      return JSON.parse(raw.toString());
    } catch {
      callLog("warn", "malformed_frame", { source });
      failCall(`malformed_${source}_frame`, 1007);
      return null;
    }
  }

  function safeSend(socket, message, target) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 1024 * 1024) {
      callLog("error", "socket_backpressure", { target, bufferedBytes: socket.bufferedAmount });
      failCall(`${target}_backpressure`, 1009);
      return false;
    }
    socket.send(message);
    return true;
  }

  function sendOpenAI(payload) {
    safeSend(openai, JSON.stringify(payload), "openai");
  }

  function sendCartesia(payload) {
    const message = JSON.stringify(payload);
    if (cartesia?.readyState === WebSocket.OPEN) safeSend(cartesia, message, "cartesia");
    else queueOrFail(cartesiaQueue, message, "cartesia_queue");
  }

  function connectCartesia() {
    if (selectedVoiceProvider !== "cartesia") return;
    cartesia = new WebSocket("wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-03-01", {
      headers: { Authorization: `Bearer ${cartesiaApiKey}` }
    });
    armProviderTimeout(cartesia, "cartesia");
    cartesia.on("open", () => {
      for (const message of cartesiaQueue.drain()) safeSend(cartesia, message, "cartesia");
      callLog("info", "provider_connected", { targetProvider: "cartesia" });
    });
    cartesia.on("message", raw => {
      const event = parseFrame(raw, "cartesia");
      if (!event) return;
      if (event.type === "chunk" && event.data && twilio.readyState === WebSocket.OPEN) {
        safeSend(twilio, JSON.stringify({ event: "media", streamSid, media: { payload: event.data } }), "twilio");
      }
      if (event.type === "error") callLog("error", "provider_error", { targetProvider: "cartesia", code: event.error?.code || event.type });
    });
    cartesia.on("error", error => callLog("error", "provider_socket_error", { targetProvider: "cartesia", message: error.message }));
    cartesia.on("close", (code, reason) => callLog("info", "provider_closed", { targetProvider: "cartesia", code, reason: reason.toString() }));
  }

  function streamTextToCartesia(text, isFinal = false) {
    if (!cartesiaContextId) cartesiaContextId = randomUUID();
    sendCartesia({
      model_id: "sonic-3.5",
      transcript: text,
      voice: { mode: "id", id: cartesiaVoiceId },
      language: "en",
      context_id: cartesiaContextId,
      output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
      continue: !isFinal,
      max_buffer_delay_ms: 350
    });
    if (isFinal) cartesiaContextId = "";
  }

  function sendSarvam(payload) {
    const message = JSON.stringify(payload);
    if (sarvam?.readyState === WebSocket.OPEN) safeSend(sarvam, message, "sarvam_tts");
    else queueOrFail(sarvamQueue, message, "sarvam_queue");
  }

  function connectSarvam() {
    if (selectedVoiceProvider !== "sarvam") return;
    const generation = ++sarvamGeneration;
    sarvam = new WebSocket("wss://api.sarvam.ai/text-to-speech/ws?model=bulbul%3Av3&send_completion_event=true", {
      headers: { "Api-Subscription-Key": sarvamApiKey }
    });
    armProviderTimeout(sarvam, "sarvam_tts");
    sarvam.on("open", () => {
      sendSarvam({
        type: "config",
        data: {
          speaker: sarvamSpeaker,
          language_code: sarvamLanguage,
          pace: 1.05,
          min_buffer_size: 30,
          max_chunk_length: 180,
          output_audio_codec: "mulaw",
          speech_sample_rate: 8000
        }
      });
      for (const message of sarvamQueue.drain()) safeSend(sarvam, message, "sarvam_tts");
      callLog("info", "provider_connected", { targetProvider: "sarvam_tts", speaker: sarvamSpeaker, language: sarvamLanguage });
    });
    sarvam.on("message", raw => {
      if (generation !== sarvamGeneration) return;
      const event = parseFrame(raw, "sarvam_tts");
      if (!event) return;
      if (event.type === "audio" && event.data?.audio && twilio.readyState === WebSocket.OPEN) {
        sarvamSpeaking = true;
        safeSend(twilio, JSON.stringify({ event: "media", streamSid, media: { payload: event.data.audio } }), "twilio");
      }
      if (["completion", "completed"].includes(event.type)) sarvamSpeaking = false;
      if (event.type === "error") callLog("error", "provider_error", { targetProvider: "sarvam_tts", code: event.data?.code });
    });
    sarvam.on("error", error => callLog("error", "provider_socket_error", { targetProvider: "sarvam_tts", message: error.message }));
    sarvam.on("close", (code, reason) => callLog("info", "provider_closed", { targetProvider: "sarvam_tts", code, reason: reason.toString() }));
  }

  function streamTextToSarvam(text, isFinal = false) {
    sarvamTextBuffer += text || "";
    const sentenceBoundary = /[.!?।]\s+/u;
    while (true) {
      const boundary = sarvamTextBuffer.search(sentenceBoundary);
      const lengthBoundary = sarvamTextBuffer.length >= 100 ? sarvamTextBuffer.lastIndexOf(" ", 100) : -1;
      const cut = boundary >= 0 ? boundary + 1 : lengthBoundary;
      if (cut <= 0) break;
      const phrase = sarvamTextBuffer.slice(0, cut).trim();
      sarvamTextBuffer = sarvamTextBuffer.slice(cut).trimStart();
      if (/\p{L}|\p{N}/u.test(phrase)) sendSarvam({ type: "text", data: { text: phrase } });
    }
    if (isFinal) {
      const phrase = sarvamTextBuffer.trim();
      if (/\p{L}|\p{N}/u.test(phrase)) sendSarvam({ type: "text", data: { text: phrase } });
      sarvamTextBuffer = "";
      sendSarvam({ type: "flush" });
    }
  }

  function interruptExternalVoice() {
    if (cartesiaContextId) sendCartesia({ context_id: cartesiaContextId, cancel: true });
    cartesiaContextId = "";
    if (selectedVoiceProvider === "sarvam" && sarvam && sarvamSpeaking) {
      sarvamGeneration += 1;
      sarvam.close(1000, "Caller interrupted");
      sarvam = null;
      sarvamSpeaking = false;
      sarvamQueue.clear();
      sarvamTextBuffer = "";
      connectSarvam();
    }
  }

  async function setupConnectorSession(config) {
    if (!composio || !config.workspaceId || !config.connectorToolkits.length) return;
    try {
      const session = await composio.sessions.create(`halacx_workspace_${config.workspaceId}`, {
        toolkits: { enable: config.connectorToolkits },
        tags: { enable: ["readOnlyHint"] },
        manageConnections: false
      });
      if (closed) return;
      connectorSession = session;
      callLog("info", "connector_session_ready", { toolkits: config.connectorToolkits });
    } catch (error) {
      connectorSession = null;
      callLog("error", "connector_session_failed", { message: error.message });
    }
  }

  async function executeConnectorFunction(name, rawArguments) {
    if (!connectorSession) return { error: "No connected tools are available" };
    let args = {};
    try { args = JSON.parse(rawArguments || "{}"); } catch { return { error: "Invalid tool arguments" }; }
    if (name === "search_connected_tools") return connectorSession.search({ query: String(args.query || "") });
    if (name === "execute_connected_tool") return connectorSession.execute(String(args.tool_slug || ""), args.arguments && typeof args.arguments === "object" ? args.arguments : {});
    return { error: "Unknown tool" };
  }

  async function generateSarvamReply(userText) {
    const cleanText = userText?.trim();
    if (!cleanText) return;
    sarvamReplyController?.abort();
    sarvamReplyController = new AbortController();
    sarvamMessages.push({ role: "user", content: cleanText });
    sarvamMessages = sarvamMessages.slice(-12);
    let assistantText = "";
    try {
      if (connectorSession) {
        const tools = [
          { type: "function", function: { name: "search_connected_tools", description: "Find the right read-only connected app tool for the caller's request. Call this before executing a connected tool.", parameters: { type: "object", properties: { query: { type: "string", description: "What information needs to be found" } }, required: ["query"] } } },
          { type: "function", function: { name: "execute_connected_tool", description: "Execute a read-only tool returned by search_connected_tools.", parameters: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["tool_slug", "arguments"] } } }
        ];
        for (let round = 0; round < 3; round += 1) {
          const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
            method: "POST",
            headers: { "api-subscription-key": sarvamApiKey, "content-type": "application/json" },
            body: JSON.stringify({ model: sarvamChatModel, messages: [{ role: "system", content: sarvamSystemPrompt }, ...sarvamMessages], tools, tool_choice: "auto", temperature: 0.25, max_tokens: 180 }),
            signal: sarvamReplyController.signal
          });
          if (!response.ok) throw new Error(`Sarvam agentic chat failed (${response.status}): ${await response.text()}`);
          const completion = await response.json();
          const message = completion.choices?.[0]?.message;
          if (!message) throw new Error("Sarvam returned no message");
          if (!message.tool_calls?.length) {
            assistantText = message.content || "I couldn't find that right now. I can take a message for the team.";
            streamTextToSarvam(assistantText, true);
            sarvamMessages.push({ role: "assistant", content: assistantText });
            sarvamMessages = sarvamMessages.slice(-16);
            return;
          }
          sarvamMessages.push(message);
          for (const call of message.tool_calls) {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || "{}"); } catch {}
            let result;
            try {
              if (call.function?.name === "search_connected_tools") result = await connectorSession.search({ query: String(args.query || "") });
              else if (call.function?.name === "execute_connected_tool") result = await connectorSession.execute(String(args.tool_slug || ""), args.arguments && typeof args.arguments === "object" ? args.arguments : {});
              else result = { error: "Unknown tool" };
            } catch (error) {
              result = { error: error.message || "Tool failed" };
            }
            sarvamMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 16000) });
          }
        }
        assistantText = "I need a little more time to check that. I can have the team follow up.";
        streamTextToSarvam(assistantText, true);
        sarvamMessages.push({ role: "assistant", content: assistantText });
        return;
      }
      const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: { "api-subscription-key": sarvamApiKey, "content-type": "application/json" },
        body: JSON.stringify({
          model: sarvamChatModel,
          messages: [{ role: "system", content: sarvamSystemPrompt }, ...sarvamMessages],
          stream: true,
          reasoning_effort: null,
          temperature: 0.35,
          max_tokens: 120
        }),
        signal: sarvamReplyController.signal
      });
      if (!response.ok || !response.body) throw new Error(`Sarvam chat failed (${response.status}): ${await response.text()}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          let event;
          try { event = JSON.parse(payload); }
          catch {
            callLog("warn", "malformed_frame", { source: "sarvam_chat_stream" });
            continue;
          }
          const text = event.choices?.[0]?.delta?.content;
          if (text) {
            assistantText += text;
            streamTextToSarvam(text);
          }
        }
      }
      streamTextToSarvam("", true);
      if (assistantText.trim()) sarvamMessages.push({ role: "assistant", content: assistantText.trim() });
      sarvamMessages = sarvamMessages.slice(-12);
    } catch (error) {
      if (error.name !== "AbortError") callLog("error", "sarvam_chat_error", { message: error.message });
    }
  }

  async function connectSarvamFullStack(parameters = {}) {
    const config = await withDeadline(loadContext(parameters.contextId, parameters.scenario), "context_load_timeout");
    await withDeadline(setupConnectorSession(config), "connector_setup_timeout");
    if (closed) return;
    sarvamSystemPrompt = `You are ${config.name}, a warm, concise HalaCX receptionist. ${config.instructions} ${scenarios[config.scenario]}

Conversation rules:
- Begin in natural, everyday Hinglish written in the Roman script.
- Use an easy Hindi-English mix, not formal Hindi and not corporate English.
- Match the caller after they respond: continue in Hinglish by default, switch to mostly Hindi or mostly English when that is clearly their preference.
- Speak naturally and keep most replies to one short sentence.
- Never repeat or paraphrase what the caller just said.
- When taking notes, say only a brief acknowledgement and ask the next necessary question.
- Ask one question at a time. Never explain your process.
- Never invent business facts. Offer a human follow-up when the knowledge does not answer the caller.
- When connected tools are available and the caller asks for live business information, quietly search the relevant tool and answer from its result. Do not announce internal tool names or your process.
- Connected tools are read-only. Never promise that you changed, sent, booked, deleted, or updated anything.

Approved business knowledge: ${config.knowledge}`;
    connectSarvam();
    streamTextToSarvam(`Hi, main ${config.name} bol rahi hoon. Bataiye, main aapki kaise help kar sakti hoon?`, true);

    const query = new URLSearchParams({
      "language-code": "unknown",
      model: sarvamSttModel,
      mode: "codemix",
      sample_rate: "8000",
      high_vad_sensitivity: "true",
      vad_signals: "true",
      input_audio_codec: "pcm_s16le"
    });
    sarvamStt = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${query}`, {
      headers: { "Api-Subscription-Key": sarvamApiKey }
    });
    armProviderTimeout(sarvamStt, "sarvam_stt");
    sarvamStt.on("open", () => {
      ready = true;
      for (const audio of bufferedAudio.drain()) sendSarvamAudio(audio);
      callLog("info", "provider_connected", { targetProvider: "sarvam_stt" });
    });
    sarvamStt.on("message", raw => {
      const event = parseFrame(raw, "sarvam_stt");
      if (!event) return;
      const signal = event.data?.signal_type || event.type;
      if (["START_SPEECH", "speech_start"].includes(signal)) {
        safeSend(twilio, JSON.stringify({ event: "clear", streamSid }), "twilio");
        sarvamReplyController?.abort();
        interruptExternalVoice();
      }
      const transcript = event.data?.transcript || (event.type === "transcript" ? event.transcript : "");
      if (transcript) generateSarvamReply(transcript);
      if (event.type === "error") callLog("error", "provider_error", { targetProvider: "sarvam_stt", code: event.data?.code });
    });
    sarvamStt.on("error", error => callLog("error", "provider_socket_error", { targetProvider: "sarvam_stt", message: error.message }));
    sarvamStt.on("close", (code, reason) => callLog("info", "provider_closed", { targetProvider: "sarvam_stt", code, reason: reason.toString() }));
  }

  function sendSarvamAudio(audio) {
    if (sarvamStt?.readyState !== WebSocket.OPEN) return;
    safeSend(sarvamStt, JSON.stringify({ audio: { data: mulawToPcm16(audio), sample_rate: "8000", encoding: "audio/wav" } }), "sarvam_stt");
  }

  async function connectOpenAI(parameters = {}) {
    const config = await withDeadline(loadContext(parameters.contextId, parameters.scenario), "context_load_timeout");
    await withDeadline(setupConnectorSession(config), "connector_setup_timeout");
    if (closed) return;
    openai = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", {
      headers: { Authorization: `Bearer ${apiKey}`, origin: "https://api.openai.com" }
    });
    armProviderTimeout(openai, "openai");
    openai.on("open", () => {
      sendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          instructions: `You are ${config.name}, a natural human-sounding HalaCX receptionist. ${config.instructions} ${scenarios[config.scenario]}

Conversation rules:
- Sound like a real person on a phone call: relaxed, warm, present, and conversational.
- Use natural contractions, varied intonation, and brief pauses where a person would breathe or think.
- Avoid a polished announcer cadence, flat rhythm, exaggerated cheerfulness, and scripted customer-service delivery.
- Let acknowledgements sound spontaneous and understated. Do not use the exact same acknowledgement repeatedly.
- Keep most replies to one short sentence. Use two only when necessary.
- Do not repeat, paraphrase, or summarize what the caller just said.
- When taking notes, capture details silently. Say only a brief acknowledgement such as "Got it" and ask the next necessary question.
- Ask one question at a time. Do not explain your process or announce what you are recording.
- Avoid filler, lists, speeches, excessive politeness, and phrases like "Just to confirm" after every detail.
- Only recap details when the caller asks, when correcting ambiguity, or once at the end before an important action.
- If the caller gives several details together, retain all of them and continue without requesting them again.
- Match the caller's language and level of formality.

Approved business knowledge: ${config.knowledge}`,
          output_modalities: [selectedVoiceProvider === "openai" ? "audio" : "text"],
          audio: {
            input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
            ...(selectedVoiceProvider === "openai" ? { output: { format: { type: "audio/pcmu" }, voice: config.voice || "coral" } } : {})
          },
          ...(connectorSession ? {
            tools: [
              { type: "function", name: "search_connected_tools", description: "Find a read-only connected app tool for live business information. Use before executing a connected tool.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
              { type: "function", name: "execute_connected_tool", description: "Execute a read-only tool returned by search_connected_tools.", parameters: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["tool_slug", "arguments"] } }
            ],
            tool_choice: "auto"
          } : {})
        }
      });
      ready = true;
      for (const audio of bufferedAudio.drain()) sendOpenAI({ type: "input_audio_buffer.append", audio });
      if (!greetingSent) {
        greetingSent = true;
        sendOpenAI({ type: "response.create", response: { instructions: `Give a brief, warm greeting in a relaxed conversational tone: "Hi, ${config.name} here — how can I help?" Do not sound like an announcement. Use the caller's language if they speak first.` } });
      }
      callLog("info", "provider_connected", { targetProvider: "openai" });
    });
    openai.on("message", raw => {
      const event = parseFrame(raw, "openai");
      if (!event) return;
      if ((event.type === "response.output_audio.delta" || event.type === "response.audio.delta") && event.delta && twilio.readyState === WebSocket.OPEN) {
        safeSend(twilio, JSON.stringify({ event: "media", streamSid, media: { payload: event.delta } }), "twilio");
      }
      if (selectedVoiceProvider === "cartesia" && (event.type === "response.output_text.delta" || event.type === "response.text.delta") && event.delta) {
        streamTextToCartesia(event.delta);
      }
      if (selectedVoiceProvider === "cartesia" && (event.type === "response.output_text.done" || event.type === "response.text.done")) {
        streamTextToCartesia("", true);
      }
      if (selectedVoiceProvider === "sarvam" && (event.type === "response.output_text.delta" || event.type === "response.text.delta") && event.delta) {
        streamTextToSarvam(event.delta);
      }
      if (selectedVoiceProvider === "sarvam" && (event.type === "response.output_text.done" || event.type === "response.text.done")) {
        streamTextToSarvam("", true);
      }
      if (event.type === "input_audio_buffer.speech_started" && twilio.readyState === WebSocket.OPEN) {
        safeSend(twilio, JSON.stringify({ event: "clear", streamSid }), "twilio");
        interruptExternalVoice();
      }
      if (event.type === "response.done") {
        const calls = (event.response?.output || []).filter(item => item.type === "function_call");
        for (const call of calls) {
          executeConnectorFunction(call.name, call.arguments).then(result => {
            sendOpenAI({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result).slice(0, 16000) } });
            sendOpenAI({ type: "response.create" });
          }).catch(error => {
            sendOpenAI({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: error.message || "Tool failed" }) } });
            sendOpenAI({ type: "response.create" });
          });
        }
      }
      if (event.type === "error") callLog("error", "provider_error", { targetProvider: "openai", code: event.error?.code, message: event.error?.message });
    });
    openai.on("close", (code, reason) => callLog("info", "provider_closed", { targetProvider: "openai", code, reason: reason.toString() }));
    openai.on("error", error => callLog("error", "provider_socket_error", { targetProvider: "openai", message: error.message }));
  }

  async function completeAdmission(parameters) {
    try {
      const result = await withDeadline(admissionStore.admit({
        jti: tokenPayload.jti,
        tokenExpiresAt: tokenPayload.exp,
        leaseId: callTraceId,
        workspaceId,
        maximum: maxGlobalActiveCalls,
        workspaceMaximum: maxWorkspaceActiveCalls,
        leaseMs: 90_000,
      }), "distributed_admission_timeout");
      if (result.status !== "admitted") return failCall(result.status === "replayed" ? "replayed_media_token" : result.status === "workspace_capacity" ? "workspace_capacity_reached" : "global_capacity_reached", 1008);
      leaseAcquired = true;
      if (closed) {
        await admissionStore.release(callTraceId, workspaceId).catch(() => {});
        return;
      }
      clearTimeout(startTimer);
      authenticated = true;
      admissionInProgress = false;
      pendingAdmission = false;
      pendingMediaConnections = Math.max(0, pendingMediaConnections - 1);
      leaseRenewal = setInterval(() => void renewAdmissionLease(), 30_000);
      leaseRenewal.unref();
      callLog("info", "call_admitted", { hasContext: Boolean(parameters.contextId) });
      connectCartesia();
      if (selectedVoiceProvider === "sarvam") {
        connectSarvamFullStack(parameters).catch(error => {
          callLog("error", "provider_connect_failed", { targetProvider: "sarvam", message: error.message });
          failCall("provider_connect_failed", 1013);
        });
      } else {
        connectOpenAI(parameters).catch(error => {
          callLog("error", "provider_connect_failed", { targetProvider: "openai", message: error.message });
          failCall("provider_connect_failed", 1013);
        });
      }
    } catch (error) {
      callLog("error", "distributed_admission_failed", { message: error.message });
      failCall("distributed_admission_unavailable", 1013);
    }
  }

  twilio.on("message", raw => {
    const event = parseFrame(raw, "twilio");
    if (!event) return;

    if (admissionInProgress) {
      if (event.event === "media" && typeof event.media?.payload === "string") queueOrFail(bufferedAudio, event.media.payload, "pre_admission_audio");
      else if (event.event === "stop") closeSocket(twilio, 1000, "Twilio stream ended");
      else if (event.event !== "connected") failCall("unexpected_event_during_admission", 1008);
      return;
    }

    if (!authenticated) {
      if (event.event === "connected" && event.protocol === "Call" && event.version === "1.0.0") return;
      if (event.event !== "start" || !event.start || typeof event.start !== "object") return failCall("expected_authenticated_start", 1008);
      const parameters = event.start.customParameters || {};
      if (!tokenPayload) {
        try { tokenPayload = verifyMediaToken(parameters.mediaToken, mediaStreamSecret); }
        catch (error) {
          callLog("warn", "media_auth_rejected", { reason: error.message });
          return failCall("invalid_media_token", 1008);
        }
      }
      try {
        if (!/^MZ[a-f0-9]{32}$/i.test(String(event.start.streamSid || ""))) throw new Error("invalid_stream_sid");
        if (!/^CA[a-f0-9]{32}$/i.test(String(event.start.callSid || ""))) throw new Error("invalid_call_sid");
        if (parameters.scenario && !(parameters.scenario in scenarios)) throw new Error("invalid_scenario");
        if (parameters.voiceProvider && !["openai", "sarvam", "cartesia"].includes(parameters.voiceProvider)) throw new Error("invalid_voice_provider");
        if (parameters.contextId && !/^[a-f0-9-]{20,64}$/i.test(parameters.contextId)) throw new Error("invalid_context_id");
        if (!parameters.workspaceId || !(parameters.workspaceId === "public-demo" || /^[a-f0-9-]{36}$/i.test(parameters.workspaceId))) throw new Error("invalid_workspace_id");
        assertMediaTokenBinding(tokenPayload, event.start);
      } catch (error) {
        callLog("warn", "media_auth_rejected", { reason: error.message });
        return failCall("invalid_start_parameters", 1008);
      }

      streamSid = event.start.streamSid;
      callSid = event.start.callSid;
      workspaceId = parameters.workspaceId;
      const requestedProvider = parameters.voiceProvider;
      if (["openai", "sarvam", "cartesia"].includes(requestedProvider)) selectedVoiceProvider = requestedProvider;
      if (["openai", "cartesia"].includes(selectedVoiceProvider) && !apiKey) return failCall("openai_not_configured", 1013);
      if (selectedVoiceProvider === "cartesia" && !cartesiaApiKey) return failCall("cartesia_not_configured", 1013);
      if (selectedVoiceProvider === "sarvam" && !sarvamApiKey) return failCall("sarvam_not_configured", 1013);
      admissionInProgress = true;
      void completeAdmission(parameters);
      return;
    }

    if (event.event === "start") return failCall("duplicate_start", 1008);
    if (event.event === "media" && event.media?.payload) {
      const audio = event.media.payload;
      if (typeof audio !== "string" || audio.length > maxFrameBytes || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return failCall("invalid_audio_payload", 1007);
      if (ready && selectedVoiceProvider === "sarvam") sendSarvamAudio(audio);
      else if (ready) sendOpenAI({ type: "input_audio_buffer.append", audio });
      else queueOrFail(bufferedAudio, audio, "startup_audio");
    } else if (event.event === "stop") {
      closeSocket(openai, 1000, "Twilio stream ended");
      closeSocket(cartesia, 1000, "Twilio stream ended");
      closeSocket(sarvam, 1000, "Twilio stream ended");
      closeSocket(sarvamStt, 1000, "Twilio stream ended");
    }
  });
  twilio.on("close", (code, reason) => {
    if (closed) return;
    closed = true;
    activeCalls = Math.max(0, activeCalls - 1);
    if (pendingAdmission) pendingMediaConnections = Math.max(0, pendingMediaConnections - 1);
    clearTimeout(startTimer);
    clearProviderTimers();
    if (leaseRenewal) clearInterval(leaseRenewal);
    bufferedAudio.clear();
    cartesiaQueue.clear();
    sarvamQueue.clear();
    sarvamReplyController?.abort();
    closeSocket(openai, 1000, "Caller disconnected");
    closeSocket(cartesia, 1000, "Caller disconnected");
    closeSocket(sarvam, 1000, "Caller disconnected");
    closeSocket(sarvamStt, 1000, "Caller disconnected");
    if (leaseAcquired) void admissionStore.release(callTraceId, workspaceId).catch(error => callLog("error", "admission_release_failed", { message: error.message }));
    callLog("info", "call_closed", { code, reason: reason.toString(), activeCalls });
  });
  twilio.on("error", error => callLog("error", "twilio_socket_error", { message: error.message }));
});

server.listen(port, "0.0.0.0", () => {
  log("info", "worker_started", { port, capacity: maxActiveCalls, globalCapacity: maxGlobalActiveCalls, workspaceCapacity: maxWorkspaceActiveCalls });
  if (appUrl && internalJobSecret) void pollInternalJobs();
  else log("warn", "internal_job_poller_disabled", { hasAppUrl: Boolean(appUrl), hasSecret: Boolean(internalJobSecret) });
});

function beginDrain(signal) {
  if (draining) return;
  draining = true;
  clearInterval(admissionHealthTimer);
  if (jobPollTimer) clearTimeout(jobPollTimer);
  let shutdownStarted = false;
  const finish = code => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void closeDatabase().finally(() => process.exit(code));
  };
  log("info", "worker_draining", { signal, activeCalls });
  server.close(error => {
    if (error) log("error", "http_close_failed", { message: error.message });
    if (activeCalls === 0) finish(error ? 1 : 0);
  });
  const deadline = positiveIntegerEnv("DRAIN_TIMEOUT_MS", 30_000, 5_000);
  const timer = setTimeout(() => {
    log("warn", "worker_drain_deadline", { activeCalls });
    for (const client of twilioServer.clients) closeSocket(client, 1012, "Worker restarting");
    finish(0);
  }, deadline);
  timer.unref();
  const poll = setInterval(() => {
    if (activeCalls !== 0) return;
    clearInterval(poll);
    clearTimeout(timer);
    finish(0);
  }, 100);
  poll.unref();
}

async function closeDatabase() {
  if (pool) await pool.end();
}

process.on("SIGTERM", () => beginDrain("SIGTERM"));
process.on("SIGINT", () => beginDrain("SIGINT"));
