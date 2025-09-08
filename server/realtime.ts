import { WebSocketServer, WebSocket } from "ws";
import { DeepgramSTTService } from "../lib/services/deepgramStt";
import { OpenAIClient, ChatMessage } from "../lib/services/openaiClient";
import { elevenlabsSynthesizeMp3 } from "../lib/services/elevenlabsTts";
import { RedisStore } from "../lib/utils/redisSession";
import { appendLatency } from "../lib/utils/metrics";

type ClientState = {
  ws: WebSocket;
  sessionId: string;
  stt: DeepgramSTTService;
  llm: OpenAIClient;
  redis: RedisStore;
  // Transcript buffers
  lastInterim: string;
  lastFinal: string;
  processing: boolean;
  // Queue of final transcripts awaiting LLM processing
  finalQueue: string[];
  // Timestamp when the last Deepgram final transcript arrived
  lastFinalAt: number | null;
};

function tryParseJson(buf: Buffer): any | null {
  if (!buf || buf.length === 0) return null;
  const b = buf[0];
  // quick precheck for '{' or '[' to avoid parsing raw audio most of the time
  if (b !== 0x7b && b !== 0x5b) return null;
  try {
    const s = buf.toString("utf8");
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const PORT = Number(process.env.REALTIME_PORT || 3001);
const wss = new WebSocketServer({ port: PORT });

console.log(`[realtime] WebSocket server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  const state: ClientState = {
    ws,
    sessionId: "default",
    stt: new DeepgramSTTService(),
    llm: new OpenAIClient(),
    redis: new RedisStore(),
    lastInterim: "",
    lastFinal: "",
    processing: false,
    finalQueue: [],
    lastFinalAt: null,
  };

  const sendJson = (obj: any) => {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    } catch {}
  };

  // Greet the client with a server hello (optional)
  sendJson({ type: "hello", message: "ws_connected" });

  // Helper: enqueue final transcripts and process sequentially
  const enqueueFinal = (text: string) => {
    const t = (text || "").trim();
    if (!t) return;
    state.finalQueue.push(t);
    if (!state.processing) void processQueue();
  };

  const processQueue = async () => {
    if (state.processing) return;
    const next = state.finalQueue.shift();
    if (!next) return;
    state.processing = true;
    try {
      // Load history
      const history = await state.redis.loadMessages(state.sessionId);
      const messages: ChatMessage[] = [
        ...(history as any),
        { role: "user", content: next },
      ];

      // One-shot LLM response (async network call; non-blocking event loop)
      const llmStartAt = Date.now();
      const assistantText = await state.llm.chatComplete(messages);
      const llmEndAt = Date.now();
      sendJson({ type: "assistant", text: assistantText });

      if (assistantText && assistantText.trim()) {
        (async () => {
          const speakText = assistantText.trim();
          try {
            const ttsStartAt = Date.now();

            const finalAt = state.lastFinalAt ?? llmStartAt;
            appendLatency({
              ts: new Date().toISOString(),
              sessionId: state.sessionId,
              query: next,
              finalReceivedAt: finalAt,
              llmStartAt,
              llmEndAt,
              ttsStartAt,
              queryToTtsStartMs: Math.max(0, ttsStartAt - finalAt),
              llmDurationMs: Math.max(0, llmEndAt - llmStartAt),
            });

            const mp3 = await elevenlabsSynthesizeMp3(speakText);
            if (mp3?.length && ws.readyState === ws.OPEN) ws.send(mp3);
          } catch (e) {
            sendJson({ type: "error", message: `TTS failed: ${String(e)}` });
          }
        })();
      }

      const updated = [
        ...messages,
        { role: "assistant", content: assistantText },
      ];
      await state.redis.saveMessages(state.sessionId, updated as any);
    } catch (e: any) {
      sendJson({ type: "error", message: e?.message || String(e) });
    } finally {
      state.processing = false;
      if (state.finalQueue.length > 0) void processQueue();
    }
  };

  state.stt.setCallbacks(
    (transcript, isFinal) => {
      if (!transcript) return;
      if (isFinal) {
        state.lastFinal = transcript;
        state.lastInterim = "";
        state.lastFinalAt = Date.now();
        sendJson({ type: "final", text: transcript });
        enqueueFinal(transcript);
      } else {
        state.lastInterim = transcript;
        sendJson({ type: "interim", text: transcript });
      }
    },
    (err) => {
      sendJson({ type: "error", message: String(err) });
    },
    undefined // ignore Deepgram utterance events
  );


  ws.on("message", async (data: Buffer) => {
    const msg = tryParseJson(data);
    if (msg && typeof msg === "object") {
      try {
        if (msg.type === "start") {
          state.sessionId = String(msg.session_id || "default");
          await state.stt.connect();
          sendJson({ type: "ready" });
          return;
        }
        if (msg.type === "stop") {
          await state.stt.disconnect();
          state.finalQueue.length = 0; 
          state.lastInterim = "";
          state.lastFinal = "";
          state.lastFinalAt = null;
          sendJson({ type: "stopped" });
          return;
        }
      } catch (e) {
        sendJson({ type: "error", message: String(e) });
      }
    } else {
      try {
        await state.stt.sendAudio(data);
      } catch (e) {
        sendJson({ type: "error", message: String(e) });
      }
    }
  });

  ws.on("close", async () => {
    try {
      await state.stt.disconnect();
    } catch {}
    state.finalQueue.length = 0;
  });
});
