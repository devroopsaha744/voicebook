type MinimalWS = {
  send: (data: string) => void;
  readyState: number;
  constructor: { OPEN: number };
};

export function startKeepalive(ws: MinimalWS, intervalMs: number = 12000): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    // In 'ws' and browser WebSocket, OPEN is a static value on the constructor
    try {
      const OPEN = (ws as any)?.constructor?.OPEN ?? 1; // 1 is OPEN per ws
      if (ws.readyState === OPEN) {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    } catch {}
  }, intervalMs);

  return timer;
}

export function stopKeepalive(timer: ReturnType<typeof setInterval>) {
  clearInterval(timer);
}
