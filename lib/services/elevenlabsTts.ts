import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/**
 * Synthesize speech using ElevenLabs and return a single MP3 Buffer.
 * - Model: eleven_flash_v2_5
 * - Format: mp3_44100_128
 */
export async function elevenlabsSynthesizeMp3(text: string): Promise<Buffer> {
  if (!text || !text.trim()) throw new Error("No text provided to ElevenLabs TTS");

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY in env");

  const voiceId = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // default

  const client = new ElevenLabsClient({ apiKey });

  const result = await client.textToSpeech.convert(voiceId, {
    text: text.trim(),
    modelId: "eleven_flash_v2_5",
    outputFormat: "mp3_44100_128",
  } as any);

  // The SDK may return one of: ArrayBuffer | Uint8Array | Buffer | Readable/Web stream
  // Normalize to Node Buffer
  const toBuffer = async (val: any): Promise<Buffer> => {
    if (!val) throw new Error("Empty ElevenLabs TTS response");
    if (Buffer.isBuffer(val)) return val;
    if (val instanceof Uint8Array) return Buffer.from(val);
    if (val instanceof ArrayBuffer) return Buffer.from(new Uint8Array(val));

    // Handle WHATWG ReadableStream
    if (typeof val === "object" && typeof val.getReader === "function") {
      const reader = val.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    }

    // Handle Node.js Readable stream
    if (typeof val === "object" && typeof val.on === "function") {
      const stream: NodeJS.ReadableStream = val;
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on("end", () => resolve());
        stream.on("error", reject);
      });
      return Buffer.concat(chunks);
    }

    // Some SDK versions return an object with `audio` property
    if (typeof val === "object" && val.audio) return toBuffer(val.audio);

    throw new Error("Unsupported ElevenLabs TTS return type");
  };

  return await toBuffer(result);
}
