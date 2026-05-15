import type { ClientToServer, ServerToClient } from "@ai-dm/shared";

export type Handler = (msg: ServerToClient) => void;

export class RoomSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private queue: ClientToServer[] = [];
  private url: string;
  private closed = false;
  private hello: Extract<ClientToServer, { type: "hello" }> | null = null;

  constructor(campaignId: string) {
    const envBase = (import.meta as any).env?.VITE_WS_URL as string | undefined;
    if (envBase) {
      const base = envBase.replace(/\/$/, "");
      this.url = `${base}/ws/${campaignId}`;
    } else {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.url = `${proto}//${location.host}/ws/${campaignId}`;
    }
  }

  connect(hello: Extract<ClientToServer, { type: "hello" }>) {
    if (this.closed) return;
    this.hello = hello;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.sendRaw(hello);
      this.queue.forEach((m) => this.sendRaw(m));
      this.queue = [];
    };
    this.ws.onmessage = (e) => {
      try {
        const msg: ServerToClient = JSON.parse(e.data);
        this.handlers.forEach((h) => h(msg));
      } catch {}
    };
    this.ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => {
        if (this.closed || !this.hello) return;
        this.connect(this.hello);
      }, 1000);
    };
  }

  close() {
    this.closed = true;
    this.handlers.clear();
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  onMessage(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(msg: ClientToServer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queue.push(msg);
      return;
    }
    this.sendRaw(msg);
  }

  private sendRaw(msg: ClientToServer) {
    this.ws?.send(JSON.stringify(msg));
  }
}
