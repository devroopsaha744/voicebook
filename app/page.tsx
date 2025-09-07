"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Msg = { id: string; role: "user" | "assistant"; text: string };

function floatTo16BitPCM(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState("disconnected");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playQueueRef = useRef<ArrayBuffer[]>([]);
  const playingRef = useRef(false);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const wsUrl = useMemo(() => {
    const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
    const port = process.env.NEXT_PUBLIC_REALTIME_PORT || 3001;
    return `ws://${host}:${port}`;
  }, []);

  useEffect(() => {
    return () => {
      try { wsRef.current?.close(); } catch {}
      try { processorRef.current?.disconnect(); } catch {}
      try { sourceRef.current?.disconnect(); } catch {}
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto scroll to bottom when messages/interim change
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, interim]);

  function queuePlayback(buf: ArrayBuffer) {
    playQueueRef.current.push(buf);
    if (!playingRef.current) void playNext();
  }

  async function playNext() {
    const buf = playQueueRef.current.shift();
    if (!buf) { playingRef.current = false; return; }
    playingRef.current = true;

    console.log("[client] Playing audio buffer:", buf.byteLength, "bytes");

    try {
      // Recreate context if missing or closed
      let ctx = audioCtxRef.current as AudioContext | null;
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioContext({ sampleRate: 48000 });
        audioCtxRef.current = ctx;
        console.log("[client] Created new AudioContext");
      }
      if (ctx.state !== "running") {
        try { await ctx.resume(); console.log("[client] AudioContext resumed"); } catch {}
      }
      if (!gainNodeRef.current) {
        const g = ctx.createGain();
        g.gain.value = 1.35; // boost TTS level a bit
        g.connect(ctx.destination);
        gainNodeRef.current = g;
        console.log("[client] Created gain node");
      }

      let audioBuf: AudioBuffer;
      try {
        // Try codec decode first (handles mp3/wav/ogg)
        audioBuf = await new Promise<AudioBuffer>((resolve, reject) =>
          ctx!.decodeAudioData(buf.slice(0), resolve, reject)
        );
        console.log("[client] Decoded via decodeAudioData", audioBuf.duration.toFixed(2), "s");
      } catch {
        // Fallback to manual PCM16/WAV path (legacy)
        const u8 = new Uint8Array(buf);
        const isWav = u8.length > 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45; // 'RIFF....WAVE'
        let pcm16: Int16Array;
        if (isWav) {
          let offset = 12; // skip RIFF header
          let dataStart = -1;
          let dataLen = 0;
          while (offset + 8 <= u8.length) {
            const id = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
            const size = u8[offset + 4] | (u8[offset + 5] << 8) | (u8[offset + 6] << 16) | (u8[offset + 7] << 24);
            offset += 8;
            if (id === "data") { dataStart = offset; dataLen = size; break; }
            offset += size + (size % 2);
          }
          if (dataStart >= 0 && dataLen > 0 && dataStart + dataLen <= u8.length) {
            const dataBuf = u8.slice(dataStart, dataStart + dataLen).buffer as ArrayBuffer;
            pcm16 = new Int16Array(dataBuf);
          } else {
            console.warn("[client] WAV without data chunk; falling back to raw");
            pcm16 = new Int16Array(buf);
          }
        } else {
          pcm16 = new Int16Array(buf);
        }
        const f32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
          const s = pcm16[i];
          f32[i] = s < 0 ? s / 32768 : s / 32767; // proper PCM16 -> float conversion
        }
        audioBuf = ctx.createBuffer(1, f32.length, 48000);
        audioBuf.copyToChannel(f32, 0);
      }

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(gainNodeRef.current!);
      src.onended = () => {
        console.log("[client] Audio playback ended");
        playNext();
      };
      src.start();
      console.log("[client] Audio playback started");
    } catch (e) {
      console.error("[client] Playback error:", e);
      playingRef.current = false;
    }
  }

  async function connect() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", session_id: crypto.randomUUID() }));
      setConnected(true);
      setStatus("connecting_stt");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ready") {
          setStatus("connected");
          // Ensure audio can play after handshake
          const ctx = audioCtxRef.current;
          if (ctx && ctx.state !== "running") {
            ctx.resume().catch(() => {});
          }
        } else if (msg.type === "interim") {
          setInterim(msg.text);
        } else if (msg.type === "final") {
          setInterim("");
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text: msg.text }]);
        } else if (msg.type === "assistant") {
          // One-shot assistant response
          console.log("[client] Received assistant message:", msg.text);
          setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: msg.text }]);
        } else if (msg.type === "error") {
          console.error("[client] Server error:", msg.message);
          setError(String(msg.message || "Unknown error"));
          setStatus("error");
        }
      } else if (ev.data instanceof ArrayBuffer) {
        // Single full audio buffer per response
        console.log("[client] Received audio buffer:", ev.data.byteLength, "bytes");
        queuePlayback(ev.data);
      }
    };
    ws.onclose = () => {
      setConnected(false);
      setRecording(false);
      setStatus("closed");
    };
    wsRef.current = ws;
  }

  async function startRecording() {
    await connect();
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (e) => {
        const ch0 = e.inputBuffer.getChannelData(0);
        const pcm = floatTo16BitPCM(ch0);
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(pcm.buffer);
        }
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
      audioCtxRef.current = audioCtx;
      sourceRef.current = source;
      processorRef.current = processor;
      setRecording(true);
  setStatus("listening");
    } catch (e) {
      console.error(e);
  setError("Microphone access denied or unavailable");
  setStatus("mic_error");
    }
  }

  function stopRecording() {
    try { wsRef.current?.send(JSON.stringify({ type: "stop" })); } catch {}
    try { processorRef.current?.disconnect(); } catch {}
    try { sourceRef.current?.disconnect(); } catch {}
  try { audioCtxRef.current?.close(); } catch {}
  audioCtxRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    setRecording(false);
  setStatus("connected");
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900">
      <header className="sticky top-0 z-10 backdrop-blur bg-white/70 border-b border-slate-200">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Voicebook</h1>
          <div className="text-xs text-slate-500">{status}</div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-2 text-sm">
              {error}
            </div>
          )}
          {/* Chat area */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div ref={chatRef} className="p-4 h-[60vh] overflow-y-auto space-y-4" id="chat-scroll">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`${m.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-900"} max-w-[80%] rounded-2xl px-4 py-2 whitespace-pre-wrap leading-relaxed`}>{m.text || (m.role === "assistant" ? "…" : "")}</div>
                </div>
              ))}
              {interim && (
                <div className="flex justify-end">
                  <div className="bg-indigo-50 text-indigo-900 border border-indigo-200 max-w-[80%] rounded-2xl px-4 py-2 opacity-80">
                    {interim}
                  </div>
                </div>
              )}
            </div>

            {/* Input/mic row */}
            <div className="border-t border-slate-200 p-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => (recording ? stopRecording() : startRecording())}
                  className={`relative w-12 h-12 rounded-full flex items-center justify-center transition-colors ${recording ? "bg-red-600 hover:bg-red-700" : "bg-indigo-600 hover:bg-indigo-700"} text-white shadow`}
                  title={recording ? "Stop" : "Start"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                    {recording ? (
                      <path d="M6 6h12v12H6z" />
                    ) : (
                      <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2zM12 19a7 7 0 0 0 7-7h2a9 9 0 1 1-18 0h2a7 7 0 0 0 7 7z" />
                    )}
                  </svg>
                  {/* Wavy animation overlay when recording */}
                  {recording && (
                    <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 wave-bars">
                      <span className="bar" />
                      <span className="bar" />
                      <span className="bar" />
                      <span className="bar" />
                      <span className="bar" />
                    </div>
                  )}
                </button>
                <div className="text-sm text-slate-500 flex-1">
                  {connected ? (recording ? "Listening… speak now" : "Connected. Tap to speak") : "Connecting…"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
