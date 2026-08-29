import http from "node:http";
import pg from "pg";
import WebSocket, { WebSocketServer } from "ws";

const { Pool } = pg;
const port = Number(process.env.PORT || 8080);
const apiKey = process.env.OPENAI_API_KEY;
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 3, ssl: { rejectUnauthorized: false } }) : null;

if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const scenarios = {
  receptionist: "Act as a front-desk receptionist. Answer questions, capture the caller's name and message, and offer a human follow-up when needed.",
  appointment: "Act as an appointment coordinator. Ask what service is needed, confirm the preferred time, and summarize the request.",
  lead: "Act as a helpful lead qualification agent. Ask about the caller's company, need, urgency, and preferred next step.",
  support: "Act as a customer-support agent. Ask for the issue and reference number, explain the next action, and escalate when human judgment is needed."
};

async function loadContext(contextId, fallbackScenario) {
  const base = {
    name: "Maya",
    voice: "marin",
    scenario: fallbackScenario in scenarios ? fallbackScenario : "receptionist",
    instructions: "Be warm, concise, multilingual, and never invent business facts.",
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
  let ready = false;
  let greetingSent = false;
  const bufferedAudio = [];

  function sendOpenAI(payload) {
    if (openai?.readyState === WebSocket.OPEN) openai.send(JSON.stringify(payload));
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
          instructions: `You are ${config.name}, a HalaCX voice receptionist. ${config.instructions} ${scenarios[config.scenario]} Approved business knowledge: ${config.knowledge}`,
          output_modalities: ["audio"],
          audio: {
            input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } },
            output: { format: { type: "audio/pcmu" }, voice: config.voice || "marin" }
          }
        }
      });
      ready = true;
      for (const audio of bufferedAudio.splice(0)) sendOpenAI({ type: "input_audio_buffer.append", audio });
      if (!greetingSent) {
        greetingSent = true;
        sendOpenAI({ type: "response.create", response: { instructions: `Introduce yourself as ${config.name} from HalaCX, welcome the caller, and ask how you can help. Keep it brief.` } });
      }
      console.log("openai_connected", { streamSid });
    });
    openai.on("message", raw => {
      const event = JSON.parse(raw.toString());
      if ((event.type === "response.output_audio.delta" || event.type === "response.audio.delta") && event.delta && twilio.readyState === WebSocket.OPEN) {
        twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload: event.delta } }));
      }
      if (event.type === "input_audio_buffer.speech_started" && twilio.readyState === WebSocket.OPEN) {
        twilio.send(JSON.stringify({ event: "clear", streamSid }));
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
      connectOpenAI(event.start.customParameters || {}).catch(error => console.error("openai_connect_failed", error.message));
    } else if (event.event === "media" && event.media?.payload) {
      if (ready) sendOpenAI({ type: "input_audio_buffer.append", audio: event.media.payload });
      else bufferedAudio.push(event.media.payload);
    } else if (event.event === "stop") {
      openai?.close(1000, "Twilio stream ended");
    }
  });
  twilio.on("close", () => openai?.close(1000, "Caller disconnected"));
  twilio.on("error", error => console.error("twilio_socket_error", error.message));
});

server.listen(port, "0.0.0.0", () => console.log(`HalaCX voice worker listening on ${port}`));
