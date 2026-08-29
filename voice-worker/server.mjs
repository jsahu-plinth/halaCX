import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";

const { Pool } = pg;
const port = Number(process.env.PORT || 8080);
const apiKey = process.env.OPENAI_API_KEY;
const voiceProvider = process.env.VOICE_PROVIDER || "openai";
const cartesiaApiKey = process.env.CARTESIA_API_KEY;
const cartesiaVoiceId = process.env.CARTESIA_VOICE_ID || "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3, ssl: { rejectUnauthorized: false } }) : null;

if (!apiKey) throw new Error("OPENAI_API_KEY is required");
if (voiceProvider === "cartesia" && !cartesiaApiKey) throw new Error("CARTESIA_API_KEY is required when VOICE_PROVIDER=cartesia");

const scenarios = {
  receptionist: "Act as a front-desk receptionist. Answer questions, capture the caller's name and message, and offer a human follow-up when needed.",
  appointment: "Act as an appointment coordinator. Ask what service is needed, confirm the preferred time, and summarize the request.",
  lead: "Act as a helpful lead qualification agent. Ask about the caller's company, need, urgency, and preferred next step.",
  support: "Act as a customer-support agent. Ask for the issue and reference number, explain the next action, and escalate when human judgment is needed."
};

async function loadContext(contextId, fallbackScenario) {
  const base = {
    name: "Maya",
    voice: "coral",
    scenario: fallbackScenario in scenarios ? fallbackScenario : "receptionist",
    instructions: "Be warm, natural, multilingual, and never invent business facts.",
    knowledge: process.env.RECEPTIONIST_KNOWLEDGE || "No approved business knowledge is available. Collect a message instead of guessing."
  };
  if (!pool || !contextId) return base;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pending = await client.query("delete from pending_call_contexts where id=$1 and expires_at>now() returning workspace_id,context,provider_call_id", [contextId]);
    const row = pending.rows[0];
    if (!row?.workspace_id) { await client.query("commit"); return { ...base, scenario: row?.context || base.scenario }; }
    const [agent, knowledge] = await Promise.all([
      client.query("select name,voice,instructions from agents where workspace_id=$1 order by created_at limit 1", [row.workspace_id]),
      client.query("select content from knowledge_sources where workspace_id=$1 and status='active' order by updated_at desc limit 30", [row.workspace_id])
    ]);
    await client.query("commit");
    return {
      ...base,
      ...agent.rows[0],
      scenario: row.context || base.scenario,
      knowledge: knowledge.rows.length ? knowledge.rows.map(item => item.content).join("\n\n").slice(0, 40000) : base.knowledge
    };
  } catch (error) {
    await client.query("rollback");
    console.error("context_load_failed", error.message);
    return base;
  } finally {
    client.release();
  }
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end();
});

const twilioServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, "http://localhost").pathname !== "/twilio-media") return socket.destroy();
  twilioServer.handleUpgrade(request, socket, head, ws => twilioServer.emit("connection", ws, request));
});

twilioServer.on("connection", twilio => {
  let streamSid = "";
  let openai = null;
  let cartesia = null;
  let ready = false;
  let greetingSent = false;
  let cartesiaContextId = "";
  const bufferedAudio = [];
  const cartesiaQueue = [];

  function sendOpenAI(payload) {
    if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify(payload));
  }

  function sendCartesia(payload) {
    const message = JSON.stringify(payload);
    if (cartesia?.readyState === WebSocket.OPEN) cartesia.send(message);
    else cartesiaQueue.push(message);
  }

  function connectCartesia() {
    if (voiceProvider !== "cartesia") return;
    cartesia = new WebSocket("wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-03-01", {
      headers: { Authorization: `Bearer ${cartesiaApiKey}` }
    });
    cartesia.on("open", () => {
      for (const message of cartesiaQueue.splice(0)) cartesia.send(message);
      console.log("cartesia_connected", { streamSid });
    });
    cartesia.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if (event.type === "chunk" && event.data && twilio.readyState === WebSocket.OPEN) {
        twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: event.data } }));
      }
      if (event.type === "error") console.error("cartesia_error", event.error || event.message || event);
    });
    cartesia.on("error", error => console.error("cartesia_socket_error", error.message));
    cartesia.on("close", (code, reason) => console.log("cartesia_closed", { streamSid, code, reason: reason.toString() }));
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

  async function connectOpenAI(parameters = {}) {
    const config = await loadContext(parameters.contextId, parameters.scenario);
    openai = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", {
      headers: { Authorization: `Bearer ${apiKey}`, origin: "https://api.openai.com" }
    });
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
          output_modalities: [voiceProvider === "cartesia" ? "text" : "audio"],
          audio: {
            input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
            ...(voiceProvider === "openai" ? { output: { format: { type: "audio/pcmu" }, voice: config.voice || "coral" } } : {})
          }
        }
      });
      ready = true;
      for (const audio of bufferedAudio.splice(0)) sendOpenAI({ type: "input_audio_buffer.append", audio });
      if (!greetingSent) {
        greetingSent = true;
        sendOpenAI({ type: "response.create", response: { instructions: `Give a brief, warm greeting in a relaxed conversational tone: "Hi, ${config.name} here — how can I help?" Do not sound like an announcement. Use the caller's language if they speak first.` } });
      }
      console.log("openai_connected", { streamSid });
    });
    openai.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if ((event.type === "response.output_audio.delta" || event.type === "response.audio.delta") && event.delta && twilio.readyState === WebSocket.OPEN) {
        twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: event.delta } }));
      }
      if (voiceProvider === "cartesia" && (event.type === "response.output_text.delta" || event.type === "response.text.delta") && event.delta) {
        streamTextToCartesia(event.delta);
      }
      if (voiceProvider === "cartesia" && (event.type === "response.output_text.done" || event.type === "response.text.done")) {
        streamTextToCartesia("", true);
      }
      if (event.type === "input_audio_buffer.speech_started" && twilio.readyState === WebSocket.OPEN) {
        twilio.send(JSON.stringify({ event: "clear", streamSid }));
        if (cartesiaContextId) sendCartesia({ context_id: cartesiaContextId, cancel: true });
        cartesiaContextId = "";
      }
      if (event.type === "error") console.error("openai_error", event.error?.code, event.error?.message);
    });
    openai.on("close", (code, reason) => console.log("openai_closed", { streamSid, code, reason: reason.toString() }));
    openai.on("error", error => console.error("openai_socket_error", error.message));
  }

  twilio.on("message", raw => {
    const event = JSON.parse(raw.toString());
    if (event.event === "start") {
      streamSid = event.start.streamSid;
      connectCartesia();
      connectOpenAI(event.start.customParameters || {}).catch(error => console.error("openai_connect_failed", error.message));
    } else if (event.event === "media" && event.media?.payload) {
      if (ready) sendOpenAI({ type: "input_audio_buffer.append", audio: event.media.payload });
      else bufferedAudio.push(event.media.payload);
    } else if (event.event === "stop") {
      openai?.close(1000, "Twilio stream ended");
      cartesia?.close(1000, "Twilio stream ended");
    }
  });
  twilio.on("close", () => { openai?.close(1000, "Caller disconnected"); cartesia?.close(1000, "Caller disconnected"); });
  twilio.on("error", error => console.error("twilio_socket_error", error.message));
});

server.listen(port, "0.0.0.0", () => console.log(`HalaCX voice worker listening on ${port}`));
