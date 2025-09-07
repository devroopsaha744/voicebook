## Voicebook Realtime Voice Agent

This project is a realtime voice assistant that captures speech in the browser, streams it to a Node.js WebSocket backend, transcribes with Deepgram STT, invokes a Groq-hosted LLM, and returns low-latency audio responses synthesized by AWS Polly (MP3). A Next.js app provides the client UI at /realtime.

Demo video
https://www.youtube.com/watch?v=v1EAKRNMLhA

## Tech stack

Node.js backend (WebSocket server)
Next.js app router frontend
Deepgram realtime STT over WebSocket
Groq LLM provider via OpenAI-compatible API
AWS Polly for TTS (MP3 output)
Redis (ioredis) for conversation history persistence

## Prerequisites

Node.js 18 or later (Node 20 recommended)
An accessible Redis instance (local or remote)
Deepgram API key
Groq API key
AWS credentials with access to Polly

## Environment variables

Create a .env.local file in the project root. The frontend and the realtime WebSocket server read from this file in development.

Required

NEXT_PUBLIC_REALTIME_PORT=3001
REALTIME_PORT=3001

DEEPGRAM_API_KEY=your_deepgram_key
# Endpointing controls how quickly Deepgram emits a final. Lower values finalize faster.
DEEPGRAM_ENDPOINTING_MS=500
# Alternative name also supported by the code
ENDPOINTING_MS=500

# Groq via OpenAI-compatible API
OPENAI_BASE_URL=https://api.groq.com/openai/v1
GROQ_API_KEY=your_groq_key
# Recommended Groq model; override as needed
LLM_MODEL=llama-3.1-70b-versatile

# Redis (use REDIS_URL or individual fields)
REDIS_URL=redis://127.0.0.1:6379
REDIS_TTL_SECONDS=86400
# Optional alternatives if not using REDIS_URL
# REDIS_HOST=127.0.0.1
# REDIS_PORT=6379
# REDIS_DB=0
# REDIS_USERNAME=
# REDIS_PASSWORD=

# AWS Polly
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1
POLLY_VOICE_ID=Joanna
POLLY_SAMPLE_RATE=24000

## Install and run locally

Install dependencies

```bash
npm install
```

Start Redis

Use any Redis you prefer. For a quick local option, run a container if Docker is available:

```bash
docker run --name voicebook-redis -p 6379:6379 -d redis:7
```

Start the app (Next.js UI and realtime WebSocket server)

```bash
npm run dev:all
```

This runs both:

Next.js dev server at http://localhost:3000
WebSocket server at ws://localhost:3001

Open the realtime page

http://localhost:3000/realtime

Click Start to grant mic access, speak a query, and you will see interim and final transcripts and hear a spoken response.

## How it works end to end

Browser capture and audio transport

The page at app/realtime/page.tsx captures microphone audio, converts it to PCM16 mono 48 kHz frames, and streams the raw bytes to the backend over a single WebSocket connection. The client also sends small JSON control messages to start and stop a session. The main landing page is at app/page.tsx.

Realtime STT with Deepgram

The backend component server/realtime.ts uses DeepgramSTTService (lib/services/deepgramStt.ts) to connect to wss://api.deepgram.com/v1/listen with interim_results, vad_events, smart_format, and the endpointing parameter enabled. Deepgram emits JSON messages for transcripts. The code streams interim transcripts to the client and waits for finalization signals before invoking the LLM:

Deepgram message fields used:
is_final indicates a finalized alternative in the current message
speech_final indicates the utterance has ended according to Deepgram endpointing/VAD
type === "UtteranceEnd" is also treated as an utterance boundary

When a transcript is final, the server enqueues it. A small queue ensures only one LLM request is in flight at a time and preserves ordering if multiple finals arrive.

LLM invocation and tool calling

OpenAIClient (lib/services/openaiClient.ts) talks to Groq through the OpenAI-compatible REST API (OPENAI_BASE_URL=https://api.groq.com/openai/v1). It loads a system prompt from lib/prompts/prompt.txt and optional few-shot examples from lib/prompts/fewshot_conversations.json to improve answer quality and validation. The client requests enable tool calling only when needed and keeps generation fast with top_p=0.9 and temperature=0.2.

Available tools implemented in lib/tools/tools.ts and exposed via lib/tools/index.ts:

get_present_date returns the current date in YYYY-MM-DD
store_on_csv(name, email, date) appends a row to bookings.csv in the project root

Flow for tool calls:

The first completion may ask to call a tool. If so, the assistant’s tool_calls are executed locally, and their JSON results are added as tool messages. A follow-up completion then produces the final user-facing answer that references the tool results. For normal Q&A without tools, the assistant responds directly in the first completion.

TTS response with AWS Polly

After the LLM generates text, the server synthesizes speech with AWS Polly to MP3 using pollySynthesizeMp3 (lib/services/awsPolly.ts). The MP3 buffer is sent over the same WebSocket to the browser. The client decodes and plays it immediately. MP3 keeps payloads small and decode/stream overhead low compared to raw PCM or WAV from other services.

Session persistence in Redis

RedisStore (lib/utils/redisSession.ts) stores the rolling conversation history per session ID with a TTL. On each final transcript, the server loads history, appends the user message, runs the LLM, sends TTS, then persists the updated history with the assistant message. Using Redis avoids losing context on server restarts and allows horizontal scaling.

## Why WebSocket and not WebRTC

Deepgram’s realtime STT API is WebSocket-only. The endpoint wss://api.deepgram.com/v1/listen expects audio frames over a WebSocket and emits JSON events for interim/final transcripts, endpointing, and utterance boundaries. Using WebRTC end-to-end would require an extra gateway layer to convert from WebRTC to Deepgram’s WebSocket API, adding latency and complexity. The current design streams audio from the browser to the backend over a single WebSocket and from there to Deepgram over another WebSocket, minimizing moving parts.

## System design choices for lower latency

Deepgram transport and endpointing

Use Deepgram’s native WebSocket API with interim_results, vad_events, and endpointing. Lower endpointing values finalize utterances sooner. Keep-alive pings prevent idle connection drops.

Fast LLM provider

Groq models are used via the OpenAI-compatible API for faster token generation compared to other providers. The model is configurable using LLM_MODEL.

Efficient TTS format

Polly returns MP3, which is compact and decodes quickly in the browser. Alternative services often return raw PCM or WAV that increase payload size and client decode time.

LLM invocation logic

The backend invokes the LLM only on Deepgram final transcripts, not on every interim chunk. A small FIFO queue ensures serialized processing and avoids overlapping model calls. The LLM call runs asynchronously so the Node.js event loop remains free to continue receiving audio and forwarding it to Deepgram; live interim/final transcripts are not blocked while the model generates. TTS synthesis is explicitly launched in a detached async task so playback preparation does not delay STT.

Durable context

Conversation history is persisted in Redis rather than in-memory arrays to avoid context loss on restart and to support multiple backend instances.

Response quality controls

Balanced sampling parameters (top_p=0.9, temperature=0.2), a focused system prompt, and curated few-shot examples improve factual answers and validation without excessive tool usage.

Targeted tool calling only

Validation rules are primarily enforced through the prompt and examples to avoid latency from tool calls on every step. Tool calling is used only for tasks that require external data or side effects, such as getting the present date and writing bookings to CSV.

## Local testing checklist

Confirm .env.local includes all required variables listed above
Ensure Redis is reachable using REDIS_URL or host/port config
Run npm run dev:all and open http://localhost:3000/realtime
Click Start, speak a complete sentence, wait for a final transcript, and listen for the Polly MP3 response
Check bookings.csv after asking the assistant to save a booking (name, email, date)

## File map and key components

server/realtime.ts WebSocket server that orchestrates STT → LLM → TTS and Redis persistence
lib/services/deepgramStt.ts Thin Deepgram WebSocket client with endpointing and VAD support
lib/services/openaiClient.ts LLM wrapper for Groq with tool calling and prompt loading
lib/services/awsPolly.ts Polly MP3 synthesis
lib/tools/tools.ts Local tools: present date and CSV append
lib/utils/redisSession.ts Redis-backed conversation history store
app/page.tsx Main landing page
app/realtime/page.tsx Client UI for streaming audio and playing TTS
