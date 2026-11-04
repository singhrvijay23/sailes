export interface ProductCard {
  id: string;
  title: string;
  brand: string | null;
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  inStock: boolean;
  rating: number | null;
  reviewCount: number | null;
  imageUrl: string | null;
  url: string | null;
  addToCartUrl: string | null;
  reason: string;
}

export interface WidgetConfig {
  storeName: string;
  platform: string;
  assistantName: string;
  greeting: string;
  primaryColor: string;
  logoUrl: string | null;
  placement: 'bottom-right' | 'bottom-left' | 'inline';
  suggestions: string[];
}

export interface StreamHandlers {
  onConversation(id: string): void;
  onText(delta: string): void;
  onProducts(items: ProductCard[]): void;
  onQuestion(q: { question: string; options: string[] }): void;
  onReset(): void;
  onError(message: string): void;
}

export class SailesClient {
  constructor(
    private apiBase: string,
    readonly key: string,
  ) {}

  private headers() {
    return { 'content-type': 'application/json', 'x-sailes-key': this.key };
  }

  async config(): Promise<WidgetConfig> {
    const r = await fetch(`${this.apiBase}/v1/widget/config`, { headers: this.headers() });
    if (!r.ok) throw new Error(`SAILES: widget config failed (${r.status})`);
    return r.json();
  }

  track(type: string, data: { conversationId?: string | null; productId?: string; value?: number; meta?: Record<string, unknown> } = {}) {
    fetch(`${this.apiBase}/v1/events`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ type, ...data }), keepalive: true }).catch(() => {});
  }

  /** POST a message and parse the server-sent event stream. */
  async chat(message: string, conversationId: string | null, visitorId: string, h: StreamHandlers, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/v1/chat`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ message, conversationId, visitorId }), signal });
    } catch {
      h.onError('Connection problem. Please try again.');
      return;
    }
    if (!res.ok || !res.body) {
      h.onError(res.status === 429 ? 'You are sending messages very quickly. Please wait a moment.' : 'Sorry, the assistant is unavailable right now.');
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        let payload: any = {};
        try {
          payload = data ? JSON.parse(data) : {};
        } catch {
          continue;
        }
        if (event === 'conversation') h.onConversation(payload.conversationId);
        else if (event === 'text') h.onText(payload.delta);
        else if (event === 'products') h.onProducts(payload.items);
        else if (event === 'question') h.onQuestion(payload);
        else if (event === 'reset') h.onReset();
        else if (event === 'error') h.onError(payload.message);
      }
    }
  }
}
