import type WebSocket from "ws";
import { startKeepalive, stopKeepalive } from "@/lib/utils/keepAlive";

type TranscriptCallback = (transcript: string, isFinal: boolean) => void;
type ErrorCallback = (err: string) => void;
type UtteranceEndCallback = (data: any) => void;

export class DeepgramSTTService {
  private api_key: string | undefined;
  private ws: WebSocket | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptCallback?: TranscriptCallback;
  private errorCallback?: ErrorCallback;
  private utteranceEndCallback?: UtteranceEndCallback;
  private _connecting = false;
  private _last_url: string | null = null;

  constructor() {
    this.api_key = process.env.DEEPGRAM_API_KEY;
  }

  setCallbacks(
    transcriptCallback?: TranscriptCallback,
    errorCallback?: ErrorCallback,
    utteranceEndCallback?: UtteranceEndCallback
  ) {
    this.transcriptCallback = transcriptCallback;
    this.errorCallback = errorCallback;
    this.utteranceEndCallback = utteranceEndCallback;
  }

  async connect(): Promise<boolean> {
    if (this.ws || this._connecting) return true;
    this._connecting = true;
    try {
      const endpointing = process.env.ENDPOINTING_MS || process.env.DEEPGRAM_ENDPOINTING_MS || "100";
      const url =
        "wss://api.deepgram.com/v1/listen" +
        "?model=nova-3" +
        "&interim_results=true" +
        "&punctuate=true" +
        "&vad_events=true" +
        `&endpointing=${endpointing}` +
        "&encoding=linear16" +
        "&sample_rate=48000" +
        "&channels=1" +
        "&smart_format=true" +
        "&language=en-GB";
      this._last_url = url;
      return await new Promise<boolean>((resolve) => {
        try {
          const protocols = ["token", this.api_key || ""];
          const WSMod: any = require("ws");
          const WS: any = WSMod?.default ?? WSMod;
          const ws = new WS(url, protocols, { maxPayload: 2 ** 23 });
          const onOpen = () => {
            this.ws = ws;
            this._setupListeners();
            try {
              this.keepaliveTimer = startKeepalive(ws as any, 12000);
            } catch {}
            cleanup();
            resolve(true);
          };
          const onError = () => {
            try {
              if (this.errorCallback) this.errorCallback("Deepgram connect failed; will retry on next audio chunk");
            } catch {}
            cleanup();
            resolve(false);
          };
          const onClose = () => {
            cleanup();
            resolve(false);
          };
          const cleanup = () => {
            ws.removeListener("open", onOpen);
            ws.removeListener("error", onError);
            ws.removeListener("close", onClose);
            this._connecting = false;
          };
          ws.once("open", onOpen);
          ws.once("error", onError);
          ws.once("close", onClose);
        } catch (e) {
          try {
            if (this.errorCallback) this.errorCallback("Deepgram connect failed; will retry on next audio chunk");
          } catch {}
          this._connecting = false;
          resolve(false);
        }
      });
    } finally {
      this._connecting = false;
    }
  }

  private _setupListeners() {
    if (!this.ws) return;
    this.ws.on("message", (data: any) => {
      try {
        const text = typeof data === "string" ? data : data.toString();
        const parsed = JSON.parse(text);
        
        console.log("[STT DEBUG]", JSON.stringify(parsed, null, 2));
        
        if (parsed && parsed.channel && Array.isArray(parsed.channel.alternatives)) {
          const alts = parsed.channel.alternatives || [];
          const alt = alts[0] || {};
          const transcript = alt.transcript || "";
          const isFinal = !!parsed.is_final;
          
          if (transcript && this.transcriptCallback) {
            try {
              this.transcriptCallback(transcript, isFinal);
            } catch {}
          }
          
          if (parsed.speech_final === true && transcript.trim()) {
            console.log("[STT] Speech final detected, triggering utterance end");
            if (this.utteranceEndCallback) {
              try {
                this.utteranceEndCallback(parsed);
              } catch {}
            }
            return;
          }
        }
        
        if (parsed && parsed.type === "UtteranceEnd") {
          console.log("[STT] UtteranceEnd event detected");
          if (this.utteranceEndCallback) {
            try {
              this.utteranceEndCallback(parsed);
            } catch {}
          }
          return;
        }
      } catch (e) {
        console.error("[STT] Parse error:", e);
      }
    });    this.ws.on("error", (err) => {
      try {
        if (this.errorCallback) this.errorCallback(`Deepgram stream error: ${String(err)}`);
      } catch {}
    });

    this.ws.on("close", () => {
      this.ws = null;
      try {
        if (this.keepaliveTimer) stopKeepalive(this.keepaliveTimer);
      } catch {}
      this.keepaliveTimer = null;
    });
  }

  async sendAudio(audioData: Buffer | ArrayBuffer | string) {
    if (!this.ws) {
      const ok = await this.connect();
      if (!ok) return;
    }
    try {
      const ws = this.ws as any;
      if (!ws) return;
      ws.send(audioData as any);
    } catch (e) {
      try {
        if (this.ws) {
          try {
            this.ws.close();
          } catch {}
        }
      } catch {}
      this.ws = null;
      await new Promise((r) => setTimeout(r, 200));
      try {
        const ok = await this.connect();
        if (ok && this.ws) {
          try {
            (this.ws as any).send(audioData as any);
          } catch {}
        }
      } catch {}
    }
  }

  async disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
    try {
      if (this.keepaliveTimer) stopKeepalive(this.keepaliveTimer);
    } catch {}
    this.keepaliveTimer = null;
  }
}
