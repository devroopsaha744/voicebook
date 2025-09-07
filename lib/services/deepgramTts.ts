import { Buffer } from "buffer";

const API_KEY = process.env.DEEPGRAM_API_KEY;
if (!API_KEY) throw new Error("DEEPGRAM_API_KEY not set");

export async function restSynthesizeBuffer(text: string): Promise<Buffer> {
  const url = `https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=48000&container=wav`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  } as any);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`REST TTS failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

