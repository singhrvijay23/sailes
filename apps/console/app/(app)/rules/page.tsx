'use client';

import { useState } from 'react';
import { api, storePath } from '@/lib/api';
import { Notice, PageHeader, errorText, useLoad } from '@/components/ui';

export default function RulesPage() {
  const { data, reload } = useLoad(() => api(storePath('/rules')));
  const [err, setErr] = useState<string | null>(null);
  const [rule, setRule] = useState({ action: 'boost', matchField: 'category', matchValue: '', weight: 1.5 });
  const [syn, setSyn] = useState({ term: '', synonyms: '' });
  const [pol, setPol] = useState({ topic: 'shipping', content: '' });

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };

  return (
    <>
      <PageHeader title="Rules & answers" subtitle="Steer what the assistant recommends and what it knows about your store." />
      {err && (
        <div className="mb-4">
          <Notice kind="error">{err}</Notice>
        </div>
      )}

      <section className="card">
        <h2 className="font-semibold">Merchandising rules</h2>
        <p className="muted">Boost products you want seen more, bury ones you want seen less, or exclude them from the assistant entirely.</p>
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[120px_130px_1fr_90px_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(storePath('/rules'), { method: 'POST', json: { ...rule, weight: Number(rule.weight) } });
              setRule({ ...rule, matchValue: '' });
            });
          }}
        >
          <select className="input" aria-label="Action" value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value })}>
            <option value="boost">Boost</option>
            <option value="bury">Bury</option>
            <option value="exclude">Exclude</option>
          </select>
          <select className="input" aria-label="Match" value={rule.matchField} onChange={(e) => setRule({ ...rule, matchField: e.target.value })}>
            <option value="category">Category</option>
            <option value="brand">Brand</option>
            <option value="tag">Tag</option>
            <option value="product">Product ID</option>
          </select>
          <input className="input" aria-label="Value" placeholder="e.g. Protein Powder" required value={rule.matchValue} onChange={(e) => setRule({ ...rule, matchValue: e.target.value })} />
          <input className="input" aria-label="Strength" type="number" min={1} max={10} step={0.1} disabled={rule.action === 'exclude'} value={rule.weight} onChange={(e) => setRule({ ...rule, weight: Number(e.target.value) })} />
          <button className="btn">Add</button>
        </form>
        <ul className="mt-3 divide-y divide-slate-100">
          {data?.rules.map((r: any) => (
            <li key={r.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <span className="pill mr-2">{r.action}</span>
                {r.match_field} = <b>{r.match_value}</b> {r.action !== 'exclude' && <span className="muted">×{r.weight}</span>}
              </span>
              <button className="btn-danger" onClick={() => run(() => api(storePath(`/rules/${r.id}`), { method: 'DELETE' }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card mt-6">
        <h2 className="font-semibold">Synonyms</h2>
        <p className="muted">Words your shoppers use that your catalog does not, for example &quot;sneakers&quot; for &quot;running shoe&quot;. They work both ways.</p>
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[200px_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(storePath('/synonyms'), { method: 'PUT', json: { term: syn.term, synonyms: syn.synonyms.split(',').map((s) => s.trim()).filter(Boolean) } });
              setSyn({ term: '', synonyms: '' });
            });
          }}
        >
          <input className="input" aria-label="Word" placeholder="sneakers" required value={syn.term} onChange={(e) => setSyn({ ...syn, term: e.target.value })} />
          <input className="input" aria-label="Means the same as" placeholder="running shoe, trainer" required value={syn.synonyms} onChange={(e) => setSyn({ ...syn, synonyms: e.target.value })} />
          <button className="btn">Save</button>
        </form>
        <ul className="mt-3 divide-y divide-slate-100">
          {data?.synonyms.map((s: any) => (
            <li key={s.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <b>{s.term}</b> = {s.synonyms.join(', ')}
              </span>
              <button className="btn-danger" onClick={() => run(() => api(storePath(`/synonyms/${s.id}`), { method: 'DELETE' }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card mt-6">
        <h2 className="font-semibold">Store policies & FAQ</h2>
        <p className="muted">The assistant quotes these when shoppers ask about shipping, returns and similar topics. It never makes up policies.</p>
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(storePath('/policies'), { method: 'PUT', json: pol });
              setPol({ topic: '', content: '' });
            });
          }}
        >
          <input className="input max-w-xs" aria-label="Topic" placeholder="shipping, returns, warranty, sizing…" required value={pol.topic} onChange={(e) => setPol({ ...pol, topic: e.target.value })} />
          <textarea className="input" aria-label="Answer" rows={3} placeholder="Free US shipping on orders over $50…" required value={pol.content} onChange={(e) => setPol({ ...pol, content: e.target.value })} />
          <button className="btn">Save policy</button>
        </form>
        <ul className="mt-3 divide-y divide-slate-100">
          {data?.policies.map((p: any) => (
            <li key={p.id} className="flex items-start justify-between gap-4 py-2 text-sm">
              <span>
                <b className="capitalize">{p.topic}:</b> {p.content}
              </span>
              <button className="btn-danger" onClick={() => run(() => api(storePath(`/policies/${p.id}`), { method: 'DELETE' }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
