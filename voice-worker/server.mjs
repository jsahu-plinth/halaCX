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
const sarvamApiKey = process.env.SARVAM_API_KEY;
const sarvamSpeaker = process.env.SARVAM_SPEAKER || "priya";
const sarvamLanguage = process.env.SARVAM_LANGUAGE || "hi-IN";
const sarvamSttModel = process.env.SARVAM_STT_MODEL || "saaras:v3";
const sarvamChatModel = process.env.SARVAM_CHAT_MODEL || "sarvam-105b-conversations";
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3, ssl: { rejectUnauthorized: false } }) : null;

if (!apiKey) throw new Error("OPENAI_API_KEY is required");
if (voiceProvider === "cartesia" && !cartesiaApiKey) throw new Error("CARTESIA_API_KEY is required when VOICE_PROVIDER=cartesia");
if (voiceProvider === "sarvam" && !sarvamApiKey) throw new Error("SARVAM_API_KEY is required when VOICE_PROVIDER=sarvam");

const scenarios = {
  receptionist: "Act as a front-desk receptionist. Answer questions, capture the caller's name and message, and offer a human follow-up when needed.",
  appointment: "Act as an appointment coordinator. Ask what service is needed, confirm the preferred time, and summarize the request.",
  lead: "Act as a helpful lead qualification agent. Ask about the caller's company, need, urgency, and preferred next step.",
  support: "Act as a customer-support agent. Ask for the issue and reference number, explain the next action, and escalate when human judgment is needed."
};

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
  let selectedVoiceProvider = voiceProvider;
  let streamSid = "";
  let openai = null;
  let cartesia = null;
  let sarvam = null;
  let sarvamStt = null;
  let ready = false;
  let greetingSent = false;
  let cartesiaContextId = "";
  const bufferedAudio = [];
  const cartesiaQueue = [];
  const sarvamQueue = [];
  let sarvamGeneration = 0;
  let sarvamSpeaking = false;
  let sarvamTextBuffer = "";
  let sarvamReplyController = null;
  let sarvamMessages = [];
  let sarvamSystemPrompt = "";

  function sendOpenAI(payload) {
    if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify(payload));
  }

  function sendCartesia(payload) {
    const message = JSON.stringify(payload);
    if (cartesia?.readyState === WebSocket.OPEN) cartesia.send(message);
    else cartesiaQueue.push(message);
  }

  function connectCartesia() {
    if (selectedVoiceProvider !== "cartesia") return;
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

  function sendSarvam(payload) {
    const message = JSON.stringify(payload);
    if (sarvam?.readyState === WebSocket.OPEN) sarvam.send(message);
    else sarvamQueue.push(message);
  }

  function connectSarvam() {
    if (selectedVoiceProvider !== "sarvam") return;
    const generation = ++sarvamGeneration;
    sarvam = new WebSocket("wss://api.sarvam.ai/text-to-speech/ws?model=bulbul%3Av3&send_completion_event=true", {
      headers: { "Api-Subscription-Key": sarvamApiKey }
    });
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
      for (const message of sarvamQueue.splice(0)) sarvam.send(message);
      console.log("sarvam_connected", { streamSid, speaker: sarvamSpeaker, language: sarvamLanguage });
    });
    sarvam.on("message", raw => {
      if (generation !== sarvamGeneration) return;
      const event = JSON.parse(raw.toString());
      if (event.type === "audio" && event.data?.audio && twilio.readyState === WebSocket.OPEN) {
        sarvamSpeaking = true;
        twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: event.data.audio } }));
      }
      if (["completion", "completed"].includes(event.type)) sarvamSpeaking = false;
      if (event.type === "error") console.error("sarvam_error", event.data?.code, event.data?.message || event);
    });
    sarvam.on("error", error => console.error("sarvam_socket_error", error.message));
    sarvam.on("close", (code, reason) => console.log("sarvam_closed", { streamSid, code, reason: reason.toString() }));
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
      sarvamQueue.length = 0;
      sarvamTextBuffer = "";
      connectSarvam();
    }
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
          const event = JSON.parse(payload);
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
      if (error.name !== "AbortError") console.error("sarvam_chat_error", error.message);
    }
  }

  async function connectSarvamFullStack(parameters = {}) {
    const config = await loadContext(parameters.contextId, parameters.scenario);
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
    sarvamStt.on("open", () => {
      ready = true;
      for (const audio of bufferedAudio.splice(0)) sendSarvamAudio(audio);
      console.log("sarvam_stt_connected", { streamSid });
    });
    sarvamStt.on("message", raw => {
      const event = JSON.parse(raw.toString());
      const signal = event.data?.signal_type || event.type;
      if (["START_SPEECH", "speech_start"].includes(signal)) {
        if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify({ event: "clear", streamSid }));
        sarvamReplyController?.abort();
        interruptExternalVoice();
      }
      const transcript = event.data?.transcript || (event.type === "transcript" ? event.transcript : "");
      if (transcript) generateSarvamReply(transcript);
      if (event.type === "error") console.error("sarvam_stt_error", event.data?.code, event.data?.message || event);
    });
    sarvamStt.on("error", error => console.error("sarvam_stt_socket_error", error.message));
    sarvamStt.on("close", (code, reason) => console.log("sarvam_stt_closed", { streamSid, code, reason: reason.toString() }));
  }

  function sendSarvamAudio(audio) {
    if (sarvamStt?.readyState !== WebSocket.OPEN) return;
    sarvamStt.send(JSON.stringify({ audio: { data: mulawToPcm16(audio), sample_rate: "8000", encoding: "audio/wav" } }));
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
          output_modalities: [selectedVoiceProvider === "openai" ? "audio" : "text"],
          audio: {
            input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
            ...(selectedVoiceProvider === "openai" ? { output: { format: { type: "audio/pcmu" }, voice: config.voice || "coral" } } : {})
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
        twilio.send(JSON.stringify({ event: "clear", streamSid }));
        interruptExternalVoice();
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
      const requestedProvider = event.start.customParameters?.voiceProvider;
      if (["openai", "sarvam", "cartesia"].includes(requestedProvider)) selectedVoiceProvider = requestedProvider;
      connectCartesia();
      if (selectedVoiceProvider === "sarvam") {
        connectSarvamFullStack(event.start.customParameters || {}).catch(error => console.error("sarvam_connect_failed", error.message));
      } else {
        connectOpenAI(event.start.customParameters || {}).catch(error => console.error("openai_connect_failed", error.message));
      }
    } else if (event.event === "media" && event.media?.payload) {
      if (ready && selectedVoiceProvider === "sarvam") sendSarvamAudio(event.media.payload);
      else if (ready) sendOpenAI({ type: "input_audio_buffer.append", audio: event.media.payload });
      else bufferedAudio.push(event.media.payload);
    } else if (event.event === "stop") {
      openai?.close(1000, "Twilio stream ended");
      cartesia?.close(1000, "Twilio stream ended");
      sarvam?.close(1000, "Twilio stream ended");
      sarvamStt?.close(1000, "Twilio stream ended");
    }
  });
  twilio.on("close", () => { sarvamReplyController?.abort(); openai?.close(1000, "Caller disconnected"); cartesia?.close(1000, "Caller disconnected"); sarvam?.close(1000, "Caller disconnected"); sarvamStt?.close(1000, "Caller disconnected"); });
  twilio.on("error", error => console.error("twilio_socket_error", error.message));
});

server.listen(port, "0.0.0.0", () => console.log(`HalaCX voice worker listening on ${port}`));
