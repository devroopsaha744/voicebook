import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { getPresentDate, storeOnCsv } from "../tools";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  name?: string;
  tool_call_id?: string;
};

type ToolResult = {
  success: boolean;
  date?: string;
  message?: string;
  error?: string;
};

export class OpenAIClient {
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey?: string, baseUrl?: string, model?: string) {
    const key = process.env.GROQ_API_KEY || apiKey || process.env.OPENAI_API_KEY || "";
    const url = baseUrl || process.env.OPENAI_BASE_URL || "https://api.groq.com/openai/v1";
    this.client = new OpenAI({ apiKey: key, baseURL: url });
    this.defaultModel = model || process.env.LLM_MODEL || "moonshotai/kimi-k2-instruct-0905"; // valid on Groq
  }

  private getTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [
      {
        type: "function",
        function: {
          name: "get_present_date",
          description: "Get current date in YYYY-MM-DD format",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "store_on_csv",
          description: "Store booking details to CSV",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "User name" },
              email: { type: "string", description: "User email" },
              date: {
                type: "string",
                description: "Booking date YYYY-MM-DD",
              },
            },
            required: ["name", "email", "date"],
          },
        },
      },
    ];
  }

  private callTool(name: string, args: Record<string, any>): ToolResult {
    try {
      if (name === "get_present_date") {
        const result = getPresentDate();
        return { success: true, date: result };
      }
      if (name === "store_on_csv") {
        const nm = args.name || args.user || args.username || args.full_name;
        const email = args.email;
        const date = args.date || args.booking_date;
        if (!nm || !email || !date) {
          return { success: false, error: "Missing required fields (name, email, date)" };
        }
        storeOnCsv(nm, email, date);
        return { success: true, message: "Booking saved successfully" };
      }
      return { success: false, error: `Unknown tool: ${name}` };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  private loadSystemPrompt(): string | null {
    try {
      const promptPath = path.resolve(process.cwd(), "lib", "prompts", "prompt.txt");
      if (fs.existsSync(promptPath)) return fs.readFileSync(promptPath, "utf-8").trim();
    } catch {}
    return null;
  }

  private maybePrependSystem(messages: ChatMessage[]): ChatMessage[] {
    if (messages.some((m) => m.role === "system")) return messages;
    const sys = this.loadSystemPrompt();
    if (sys) return [{ role: "system", content: sys }, ...messages];
    return messages;
  }

  async *chatStream(messages: ChatMessage[], model?: string) {
    const tools = this.getTools();
    const finalModel = model || this.defaultModel;
    messages = this.maybePrependSystem(messages);

    const stream = await this.client.chat.completions.create({
      model: finalModel,
      messages: messages as any,
      stream: true,
      tools,
      tool_choice: "auto",
      top_p: 0.9,
      temperature: 0.2,
    });

    const collectedToolCalls: any[] = [];

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta: any = choice.delta || {};
      if (delta.content) {
        yield { type: "token", value: delta.content } as const;
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          collectedToolCalls.push(tc);
        }
      }
      if (choice.finish_reason === "tool_calls") break;
    }

    if (collectedToolCalls.length) {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: null,
        tool_calls: collectedToolCalls.map((tc: any) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      } as any;
      const toolResults: ChatMessage[] = [];
      for (const tc of collectedToolCalls) {
        const name = tc.function.name;
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const result = this.callTool(name, args);
        toolResults.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: tc.id,
        });
      }
      const followUp = await this.client.chat.completions.create({
        model: finalModel,
        messages: [...messages, assistantMsg, ...toolResults] as any,
        stream: true,
        top_p: 0.9,
        temperature: 0.2,
      });
      for await (const chunk of followUp) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta: any = choice.delta || {};
        if (delta.content) yield { type: "token", value: delta.content } as const;
      }
    }
  }

  async chatComplete(messages: ChatMessage[], model?: string): Promise<string> {
    const tools = this.getTools();
    const finalModel = model || this.defaultModel;
    messages = this.maybePrependSystem(messages);

  // Ensure consistent non-streaming responses with small retry budget
  for (let i = 0; i < 3; i++) {
      const resp = await this.client.chat.completions.create({
        model: finalModel,
        messages: messages as any,
        stream: false,
        tools,
        tool_choice: "auto",
        top_p: 0.9,
        temperature: 0.2,
      });

      const choice: any = resp.choices?.[0];
      if (!choice) continue;
      const msg: any = choice.message;
      if (msg?.content) return msg.content as string;
      const toolCalls = msg?.tool_calls || [];
      if (!toolCalls.length) continue;

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((tc: any) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      } as any;

      const toolMessages: ChatMessage[] = [];
      for (const tc of toolCalls) {
        const name = tc.function.name;
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const result = this.callTool(name, args);
        toolMessages.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: tc.id,
        });
      }

  messages = [...messages, assistantMessage, ...toolMessages];
    }

    return "";
  }
}
