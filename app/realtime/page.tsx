"use client";
import { useEffect, useRef, useState } from "react";

function floatTo16BitPCM(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export default function RealtimePage() {
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [finals, setFinals] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playQueueRef = useRef<ArrayBuffer[]>([]);
  const playingRef = useRef(false);

  useEffect(() => {
    return () => {
      try { wsRef.current?.close(); } catch {}
      try { processorRef.current?.disconnect(); } catch {}
      try { sourceRef.current?.disconnect(); } catch {}
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, []);

  async function start() {
    const ws = new WebSocket(`ws://localhost:${process.env.NEXT_PUBLIC_REALTIME_PORT || 3001}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", session_id: crypto.randomUUID() }));
      setStatus("connected");
    };
    ws.onmessage = async (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data);
        if (msg.type === "interim") setTranscript(msg.text);
        else if (msg.type === "final") setFinals((f) => [...f, msg.text]);
        else if (msg.type === "error") console.error(msg.message);
      } else if (ev.data instanceof ArrayBuffer) {
        // PCM16 mono 48k from server (Deepgram TTS)
        queuePlayback(ev.data);
      }
    };
    ws.onclose = () => setStatus("closed");
    wsRef.current = ws;

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
    setStarted(true);
  }

  function queuePlayback(buf: ArrayBuffer) {
    playQueueRef.current.push(buf);
    if (!playingRef.current) playNext();
  }

  async function playNext() {
    const buf = playQueueRef.current.shift();
    if (!buf) { playingRef.current = false; return; }
    playingRef.current = true;
    try {
      const ctx = audioCtxRef.current || new AudioContext({ sampleRate: 48000 });
      audioCtxRef.current = ctx;

      let audioBuf: AudioBuffer;
      try {
        audioBuf = await new Promise<AudioBuffer>((resolve, reject) =>
          ctx.decodeAudioData(buf.slice(0), resolve, reject)
        );
      } catch {
        // Fallback: treat as PCM16 mono 48k
        const pcm16 = new Int16Array(buf);
        const f32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) f32[i] = Math.max(-1, pcm16[i] / 0x8000);
        audioBuf = ctx.createBuffer(1, f32.length, 48000);
        audioBuf.copyToChannel(f32, 0);
      }
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(ctx.destination);
      src.onended = () => playNext();
      src.start();
    } catch (e) {
      console.error("playback error", e);
      playingRef.current = false;
    }
  }

  function stop() {
    try { wsRef.current?.send(JSON.stringify({ type: "stop" })); } catch {}
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    setStarted(false);
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Realtime Voice</h1>
      <div className="flex items-center gap-3">
        <button className="px-3 py-2 bg-black text-white rounded" onClick={() => (started ? stop() : start())}>
          {started ? "Stop" : "Start"}
        </button>
        <span className="text-sm text-gray-600">{status}</span>
      </div>
      <div>
        <h2 className="font-medium mb-1">Interim</h2>
        <div className="p-2 rounded bg-gray-100 min-h-[40px]">{transcript}</div>
      </div>
      <div>
        <h2 className="font-medium mb-1">Final</h2>
        <ul className="list-disc pl-5 space-y-1">
          {finals.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
