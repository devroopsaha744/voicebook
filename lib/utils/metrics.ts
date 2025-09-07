import fs from "fs";
import path from "path";

export type LatencyRecord = {
  ts: string; // ISO timestamp when recorded
  sessionId: string;
  query: string;
  finalReceivedAt: number; // epoch ms
  llmStartAt: number; // epoch ms
  llmEndAt: number; // epoch ms
  ttsStartAt: number; // epoch ms
  queryToTtsStartMs: number; // ttsStartAt - finalReceivedAt
  llmDurationMs: number; // llmEndAt - llmStartAt
};

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function appendLatency(record: LatencyRecord) {
  try {
    const dir = path.resolve(process.cwd(), "logs");
    ensureDir(dir);
    const file = path.join(dir, "latency.json");
    let arr: LatencyRecord[] = [];
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, "utf-8");
        arr = JSON.parse(raw);
        if (!Array.isArray(arr)) arr = [];
      } catch {
        arr = [];
      }
    }
    arr.push(record);
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), { encoding: "utf-8" });
  } catch {
    // best-effort; ignore errors
  }
}
