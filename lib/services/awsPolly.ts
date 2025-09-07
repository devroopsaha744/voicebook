import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

let client: PollyClient | null = null;

function getClient() {
  if (!client) {
    client = new PollyClient({
      region: process.env.AWS_REGION || "us-east-1",
      // Credentials are automatically read from environment variables or shared config
    });
  }
  return client;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  // Handles Node Readable streams and browser-like blobs/streams
  if (!stream) throw new Error("Empty AudioStream from Polly");
  if (Buffer.isBuffer(stream)) return stream;
  if (stream instanceof Uint8Array) return Buffer.from(stream);

  if (typeof stream.arrayBuffer === "function") {
    const ab = await stream.arrayBuffer();
    return Buffer.from(ab);
  }

  if (typeof stream.getReader === "function") {
    // Web ReadableStream
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.from(chunks.reduce((acc, cur) => Buffer.concat([acc, Buffer.from(cur)]), Buffer.alloc(0)));
  }

  if (typeof stream.on === "function" && typeof stream.read === "function") {
    // Node Readable
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported AudioStream type returned by Polly");
}

/**
 * Synthesize text to MP3 audio using AWS Polly and return it as a Buffer.
 * Voice can be provided via POLLY_VOICE_ID env, defaults to 'Joanna'.
 */
export async function pollySynthesizeMp3(text: string): Promise<Buffer> {
  const voiceId = process.env.POLLY_VOICE_ID || "Joanna";
  const params = {
    OutputFormat: "mp3" as const,
    Text: text,
    VoiceId: voiceId as any,
    // Engine can be set to 'neural' if the chosen voice supports it; omit by default for compatibility
    // Engine: process.env.POLLY_ENGINE as any,
    SampleRate: process.env.POLLY_SAMPLE_RATE || "24000",
    TextType: "text" as const,
  };

  const res = await getClient().send(new SynthesizeSpeechCommand(params));
  const audio = await streamToBuffer(res.AudioStream as any);
  if (!audio || !audio.length) throw new Error("Polly returned empty audio buffer");
  return audio;
}
