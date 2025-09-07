import Redis from "ioredis";

export interface Message {
  role: string;
  content: string | null;
  [key: string]: any;
}

export class RedisStore {
  private ttl: number;
  private client: Redis;

  constructor() {
    this.ttl = parseInt(process.env.REDIS_TTL_SECONDS || "86400", 10);

    const url = process.env.REDIS_URL;
    const host = process.env.REDIS_HOST || "localhost";
    const port = parseInt(process.env.REDIS_PORT || "6379", 10);
    const db = parseInt(process.env.REDIS_DB || "0", 10);
  const password = process.env.REDIS_PASSWORD;
  const username = process.env.REDIS_USERNAME;

    if (url) {
      this.client = new Redis(url);
    } else {
  this.client = new Redis({ host, port, db, password, username });
    }
  }

  private key(sessionId: string): string {
    return `session:${sessionId}:messages`;
  }

  async loadMessages(sessionId: string): Promise<Message[]> {
    try {
      const data = await this.client.get(this.key(sessionId));
      if (!data) return [];
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async saveMessages(sessionId: string, messages: Message[]): Promise<void> {
    const payload = JSON.stringify(messages.slice(-200));
    try {
      await this.client.set(this.key(sessionId), payload, "EX", this.ttl);
    } catch {}
  }
}
