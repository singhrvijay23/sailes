'use client';

import { useEffect, useState } from 'react';
import { api, storePath } from '@/lib/api';
import { useStore } from '@/components/store';
import { Notice, PageHeader, errorText, useLoad } from '@/components/ui';

const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', gemini: 'Google Gemini', anthropic: 'Anthropic Claude' };
const KEY_HELP: Record<string, string> = {
  openai: 'Create a key at platform.openai.com → API keys. It starts with "sk-".',
  gemini: 'Create a key at aistudio.google.com → Get API key.',
  anthropic: 'Create a key at console.anthropic.com → API keys. It starts with "sk-ant-".',
};

export default function AiPage() {
  const { data: store, reload } = useStore();
  const providers = useLoad(() => api('/v1/ai/providers'));
  const [mode, setMode] = useState<'demo' | 'byok' | 'managed'>('byok');
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [budget, setBudget] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!store) return;
    setMode(store.store.ai_mode === 'demo' ? 'byok' : store.store.ai_mode);
    if (store.ai) {
      setProvider(store.ai.provider);
      setModel(store.ai.chat_model);
    }
    setBudget(String(store.store.monthly_budget_usd));
  }, [store?.store.id]);

  const info = providers.data?.providers.find((p: any) => p.id === provider);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const body = mode === 'byok' ? { mode, provider, apiKey: apiKey || undefined, chatModel: model || info?.defaultModel } : { mode };
      const r = await api(storePath('/ai'), { method: 'PUT', json: body });
      if (budget) await api(storePath(), { method: 'PATCH', json: { monthlyBudgetUsd: Number(budget) } });
      setApiKey('');
      setMsg({ kind: 'success', text: `Saved.${r.reindexing ? ` Re-indexing ${r.reindexing} products for the new provider in the background.` : ''}` });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm('Remove the stored AI key? The assistant falls back to demo mode.')) return;
    await api(storePath('/ai'), { method: 'DELETE' });
    await reload();
  }

  return (
    <>
      <PageHeader title="AI connection" subtitle="Use your own AI key so you control AI spend. Keys are encrypted and never shown again in full." />
      {msg && (
        <div className="mb-4">
          <Notice kind={msg.kind}>{msg.text}</Notice>
        </div>
      )}
      {store?.ai && (
        <div className="card mb-4 flex items-center justify-between">
          <div>
            <div className="font-semibold">
              Connected: {PROVIDER_NAMES[store.ai.provider]} · {store.ai.chat_model}
            </div>
            <div className="muted">Key {store.ai.key} · checked {new Date(store.ai.validated_at).toLocaleString('en-US')}</div>
          </div>
          <button className="btn-ghost" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}

      <div className="card space-y-5">
        <fieldset>
          <legend className="label">How should SAILES get its AI?</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { id: 'byok', title: 'My own API key', text: 'You pay your AI provider directly.' },
              { id: 'managed', title: 'SAILES AI credits', text: providers.data?.managedAvailable ? 'We supply the AI. Prepaid credits.' : 'Coming soon.' },
              { id: 'demo', title: 'Demo mode', text: 'Rule-based answers, no AI cost.' },
            ].map((o) => (
              <label key={o.id} className={`cursor-pointer rounded-lg border p-3 ${mode === o.id ? 'border-navy ring-2 ring-navy/20' : 'border-slate-200'} ${o.id === 'managed' && !providers.data?.managedAvailable ? 'opacity-50' : ''}`}>
                <input type="radio" className="sr-only" name="mode" checked={mode === o.id} disabled={o.id === 'managed' && !providers.data?.managedAvailable} onChange={() => setMode(o.id as any)} />
                <div className="text-sm font-semibold">{o.title}</div>
                <div className="muted">{o.text}</div>
              </label>
            ))}
          </div>
        </fieldset>

        {mode === 'byok' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="provider">Provider</label>
                <select
                  id="provider"
                  className="input"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setModel('');
                  }}
                >
                  {Object.entries(PROVIDER_NAMES).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="model">Model</label>
                <select id="model" className="input" value={model || info?.defaultModel || ''} onChange={(e) => setModel(e.target.value)}>
                  {info?.models.map((m: string) => (
                    <option key={m} value={m}>
                      {m}
                      {m === info.defaultModel ? ' (recommended)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="key">API key</label>
              <input id="key" className="input font-mono" type="password" autoComplete="off" placeholder={store?.ai?.provider === provider ? 'Leave empty to keep the current key' : 'Paste your API key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              <p className="muted mt-1">{KEY_HELP[provider]} We test it with one small call before saving.</p>
              {provider === 'anthropic' && <p className="muted mt-1">Claude has no embeddings API, so product search uses SAILES&apos; built-in keyword and fuzzy matching.</p>}
            </div>
          </>
        )}

        <div className="max-w-xs">
          <label className="label" htmlFor="budget">Monthly AI budget (USD)</label>
          <input id="budget" className="input" type="number" min={0} step={5} value={budget} onChange={(e) => setBudget(e.target.value)} />
          <p className="muted mt-1">When reached, the assistant switches to keyword search instead of stopping. Spend is an estimate; your provider bill is final.</p>
        </div>

        <button className="btn" onClick={save} disabled={busy}>
          {busy ? 'Checking key…' : 'Save'}
        </button>
      </div>
    </>
  );
}
