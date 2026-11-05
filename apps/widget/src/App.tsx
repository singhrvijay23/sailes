import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProductCard, SailesClient, WidgetConfig } from './api';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  products: ProductCard[];
  question: { question: string; options: string[] } | null;
  error?: boolean;
}

interface Props {
  client: SailesClient;
  inline: boolean;
  controls: { open(): void; close(): void; send(text: string): void };
}

const store = {
  get(k: string) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function visitorId() {
  try {
    let id = localStorage.getItem('sailes_vid');
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('sailes_vid', id);
    }
    return id;
  } catch {
    return 'anon';
  }
}

function money(n: number | null, currency: string) {
  if (n == null) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

let nextId = 1;

export function App({ client, inline, controls }: Props) {
  const [cfg, setCfg] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(inline);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const convKey = `sailes_conv_${client.key.slice(-12)}`;
  const conv = useRef<string | null>(store.get(convKey));
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const vid = useRef(visitorId());

  useEffect(() => {
    client
      .config()
      .then(setCfg)
      .catch((e) => console.warn(e));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      client.track('widget_open', { conversationId: conv.current });
    }
  }, [open]);

  const update = (id: number, fn: (m: Msg) => Msg) => setMsgs((list) => list.map((m) => (m.id === id ? fn(m) : m)));

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    const botId = nextId++;
    setMsgs((list) => [...list, { id: nextId++, role: 'user', text: message, products: [], question: null }, { id: botId, role: 'assistant', text: '', products: [], question: null }]);
    await client.chat(message, conv.current, vid.current, {
      onConversation(id) {
        conv.current = id;
        store.set(convKey, id);
      },
      onText: (d) => update(botId, (m) => ({ ...m, text: m.text + d })),
      onProducts: (items) => update(botId, (m) => ({ ...m, products: [...m.products, ...items] })),
      onQuestion: (q) => update(botId, (m) => ({ ...m, question: q })),
      onReset: () => update(botId, (m) => ({ ...m, text: '', products: [], question: null })),
      onError: (message) => update(botId, (m) => ({ ...m, text: m.text || message, error: true })),
    });
    setBusy(false);
  }

  controls.open = () => setOpen(true);
  controls.close = () => setOpen(false);
  controls.send = (t) => {
    setOpen(true);
    void send(t);
  };

  function addToCart(p: ProductCard) {
    client.track('add_to_cart', { conversationId: conv.current, productId: p.id, value: p.price ?? undefined });
    // Platform connectors (WooCommerce, Shopify) listen for this event and add to the real cart.
    const ev = new CustomEvent('sailes:add-to-cart', { detail: { productId: p.id, url: p.url, addToCartUrl: p.addToCartUrl, conversationId: conv.current }, cancelable: true });
    const handled = !window.dispatchEvent(ev);
    if (!handled) {
      const target = p.addToCartUrl ?? p.url;
      if (target) window.location.href = target;
    }
  }

  function viewProduct(p: ProductCard) {
    client.track('click', { conversationId: conv.current, productId: p.id });
  }

  const color = cfg?.primaryColor ?? '#1B2A4A';
  const side = cfg?.placement === 'bottom-left' ? 'left' : 'right';
  const last = msgs[msgs.length - 1];

  if (!open && !inline) {
    return (
      <button class={`sl-bubble sl-${side}`} style={{ background: color }} aria-label={`Chat with ${cfg?.assistantName ?? 'our shopping assistant'}`} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 9h2v2H7v-2zm4-3h2v5h-2v-5zm4-3h2v8h-2V7z" />
        </svg>
      </button>
    );
  }

  return (
    <section
      class={`sl-panel ${inline ? 'sl-inline' : `sl-floating sl-${side}`}`}
      style={{ '--sl-primary': color } as any}
      aria-label={`${cfg?.assistantName ?? 'Shopping assistant'} chat`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !inline) setOpen(false);
      }}
    >
      <header class="sl-header">
        {cfg?.logoUrl ? <img class="sl-logo" src={cfg.logoUrl} alt="" /> : <span class="sl-dot" aria-hidden="true" />}
        <div class="sl-title">
          <strong>{cfg?.assistantName ?? 'Shopping assistant'}</strong>
          <span>{cfg?.storeName}</span>
        </div>
        {!inline && (
          <button class="sl-close" aria-label="Close chat" onClick={() => setOpen(false)}>
            ×
          </button>
        )}
      </header>

      <div class="sl-log" ref={logRef} role="log" aria-live="polite">
        <div class="sl-msg sl-assistant">
          <p>{cfg?.greeting ?? 'Hi! What are you shopping for today?'}</p>
        </div>
        {msgs.length === 0 && cfg?.suggestions?.length ? (
          <div class="sl-chips">
            {cfg.suggestions.map((s) => (
              <button class="sl-chip" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {msgs.map((m) => (
          <div class={`sl-msg sl-${m.role}${m.error ? ' sl-error' : ''}`} key={m.id}>
            {m.text ? <p>{m.text}</p> : m.role === 'assistant' && busy && m === last ? <p class="sl-typing" aria-label="Typing">•••</p> : null}
            {m.products.length > 0 && (
              <ul class="sl-cards">
                {m.products.map((p) => (
                  <li class="sl-card" key={p.id}>
                    {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" />}
                    <div class="sl-card-body">
                      <a href={p.url ?? '#'} target="_top" class="sl-card-title" onClick={() => viewProduct(p)}>
                        {p.title}
                      </a>
                      <div class="sl-price">
                        {money(p.price, p.currency)}
                        {p.compareAtPrice && p.price != null && p.compareAtPrice > p.price ? <s>{money(p.compareAtPrice, p.currency)}</s> : null}
                      </div>
                      {p.rating ? (
                        <div class="sl-rating" aria-label={`Rated ${p.rating} out of 5`}>
                          ★ {p.rating.toFixed(1)} {p.reviewCount ? <span>({p.reviewCount})</span> : null}
                        </div>
                      ) : null}
                      <p class="sl-reason">{p.reason}</p>
                      <button class="sl-add" onClick={() => addToCart(p)}>
                        Add to cart
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {m.question && m === last && !busy && (
              <div class="sl-chips">
                {m.question.options.map((o) => (
                  <button class="sl-chip" onClick={() => send(o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        class="sl-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label class="sl-sr" for="sl-input">
          Message
        </label>
        <textarea
          id="sl-input"
          ref={inputRef}
          rows={1}
          value={input}
          maxLength={2000}
          placeholder="Ask about any product…"
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button type="submit" class="sl-send" disabled={busy || !input.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M3 20l18-8L3 4v6l12 2-12 2z" />
          </svg>
        </button>
      </form>
      <footer class="sl-foot">Powered by SAILES</footer>
    </section>
  );
}
