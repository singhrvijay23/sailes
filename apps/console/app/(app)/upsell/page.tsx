'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, storePath } from '@/lib/api';
import { Notice, PageHeader, errorText, useLoad } from '@/components/ui';

type Kind = 'cross_sell' | 'bundle' | 'discount';
type Product = { id: string; title: string; price: number };

const KINDS: Record<Kind, { title: string; text: string }> = {
  cross_sell: { title: 'Cross-sell', text: 'When a shopper looks at matching products, suggest these first.' },
  bundle: { title: 'Bundle', text: 'A set of products the assistant can offer together.' },
  discount: { title: 'Discount', text: 'A promotion the assistant may mention. It never makes up its own.' },
};

const EMPTY = { kind: 'cross_sell' as Kind, name: '', triggerField: 'category', triggerValue: '', products: [] as Product[], discountText: '', discountCode: '', minCartValue: '', endsAt: '' };

function ProductPicker({ value, onChange }: { value: Product[]; onChange: (p: Product[]) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => {
      api(storePath(`/catalog?page=1&q=${encodeURIComponent(q)}`))
        .then((r) => setResults(r.items.slice(0, 6)))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {value.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm">
            {p.title}
            <button type="button" aria-label={`Remove ${p.title}`} className="text-slate-500 hover:text-red-600" onClick={() => onChange(value.filter((x) => x.id !== p.id))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input className="input mt-2" placeholder="Search your catalog to add products" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.length > 0 && (
        <ul className="mt-1 divide-y rounded-lg border border-slate-200 bg-white text-sm">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50"
                onClick={() => {
                  if (!value.some((x) => x.id === p.id)) onChange([...value, p]);
                  setQ('');
                }}
              >
                <span>{p.title}</span>
                <span className="muted">
                  {p.id} · ${p.price}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describe(r: any) {
  const when = r.trigger_field === 'any' ? 'any product' : r.trigger_field ? `${r.trigger_field} "${r.trigger_value}"` : null;
  if (r.kind === 'cross_sell') return `On ${when}, suggest ${r.target_product_ids.join(', ')}`;
  if (r.kind === 'bundle') return `${r.target_product_ids.join(' + ')}${r.discount_text ? ` · ${r.discount_text}` : ''}`;
  return `On ${when}: ${r.discount_text}${r.discount_code ? ` (code ${r.discount_code})` : ''}${r.min_cart_value ? `, orders over $${r.min_cart_value}` : ''}`;
}

export default function UpsellPage() {
  const { data, reload } = useLoad(() => api(storePath('/upsell-rules')));
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api(storePath('/upsell-rules'), {
        method: 'POST',
        json: {
          kind: form.kind,
          name: form.name,
          triggerField: form.kind === 'bundle' ? null : form.triggerField,
          triggerValue: form.triggerField === 'any' ? null : form.triggerValue,
          targetProductIds: form.kind === 'discount' ? [] : form.products.map((p) => p.id),
          discountText: form.discountText || null,
          discountCode: form.discountCode || null,
          minCartValue: form.minCartValue ? Number(form.minCartValue) : null,
          endsAt: form.endsAt ? new Date(`${form.endsAt}T23:59:59`).toISOString() : null,
        },
      });
      setForm({ ...EMPTY, kind: form.kind });
      reload();
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: any) {
    await api(storePath(`/upsell-rules/${r.id}`), {
      method: 'PUT',
      json: { kind: r.kind, name: r.name, triggerField: r.trigger_field, triggerValue: r.trigger_value, targetProductIds: r.target_product_ids, discountText: r.discount_text, discountCode: r.discount_code, minCartValue: r.min_cart_value, active: !r.active, startsAt: r.starts_at, endsAt: r.ends_at },
    }).catch((e) => setErr(errorText(e)));
    reload();
  }

  async function remove(id: string) {
    await api(storePath(`/upsell-rules/${id}`), { method: 'DELETE' });
    reload();
  }

  if (data && !data.available) {
    return (
      <>
        <PageHeader title="Upsell & bundles" subtitle="Tell the assistant what to suggest alongside your products." />
        <Notice kind="info">
          Cross-sell rules, bundles and discount offers are part of the Pro plan. <Link className="underline" href="/billing">See plans</Link>
        </Notice>
      </>
    );
  }

  const needsTrigger = form.kind !== 'bundle';
  return (
    <>
      <PageHeader title="Upsell & bundles" subtitle="Tell the assistant what to suggest alongside your products, and which offers it may mention." />
      {err && (
        <div className="mb-4">
          <Notice kind="error">{err}</Notice>
        </div>
      )}

      <form className="card mb-6 space-y-4" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(KINDS) as Kind[]).map((k) => (
            <label key={k} className={`cursor-pointer rounded-lg border p-3 ${form.kind === k ? 'border-navy ring-2 ring-navy/20' : 'border-slate-200'}`}>
              <input type="radio" className="sr-only" name="kind" checked={form.kind === k} onChange={() => setForm({ ...EMPTY, kind: k })} />
              <div className="text-sm font-semibold">{KINDS[k].title}</div>
              <div className="muted">{KINDS[k].text}</div>
            </label>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="rname">Name</label>
          <input id="rname" className="input" required maxLength={120} placeholder={form.kind === 'bundle' ? 'e.g. Morning coffee set' : 'e.g. Mugs with coffee'} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        {needsTrigger && (
          <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
            <div>
              <label className="label" htmlFor="tfield">{form.kind === 'discount' ? 'Applies to' : 'When the shopper looks at'}</label>
              <select id="tfield" className="input" value={form.triggerField} onChange={(e) => setForm({ ...form, triggerField: e.target.value })}>
                <option value="category">Category</option>
                <option value="tag">Tag</option>
                <option value="product">Product ID</option>
                <option value="any">Any product</option>
              </select>
            </div>
            {form.triggerField !== 'any' && (
              <div>
                <label className="label" htmlFor="tvalue">Value</label>
                <input id="tvalue" className="input" required placeholder={form.triggerField === 'product' ? 'e.g. GFT-006' : 'e.g. Mugs'} value={form.triggerValue} onChange={(e) => setForm({ ...form, triggerValue: e.target.value })} />
              </div>
            )}
          </div>
        )}
        {form.kind !== 'discount' && (
          <div>
            <span className="label">{form.kind === 'bundle' ? 'Products in the bundle' : 'Suggest these products'}</span>
            <ProductPicker value={form.products} onChange={(products) => setForm({ ...form, products })} />
          </div>
        )}
        {form.kind !== 'cross_sell' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="dtext">{form.kind === 'bundle' ? 'Bundle offer (optional)' : 'Offer, as the assistant should say it'}</label>
              <input id="dtext" className="input" required={form.kind === 'discount'} maxLength={200} placeholder="e.g. 15% off a second mug" value={form.discountText} onChange={(e) => setForm({ ...form, discountText: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="dcode">Code (optional)</label>
              <input id="dcode" className="input font-mono" maxLength={60} value={form.discountCode} onChange={(e) => setForm({ ...form, discountCode: e.target.value })} />
            </div>
            {form.kind === 'discount' && (
              <div>
                <label className="label" htmlFor="dmin">Minimum order (optional)</label>
                <input id="dmin" className="input" type="number" min={0} step={1} value={form.minCartValue} onChange={(e) => setForm({ ...form, minCartValue: e.target.value })} />
              </div>
            )}
            <div>
              <label className="label" htmlFor="dend">Ends on (optional)</label>
              <input id="dend" className="input" type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
            </div>
          </div>
        )}
        {form.kind !== 'cross_sell' && <p className="muted">The discount itself is applied by your store at checkout. SAILES only tells shoppers about it.</p>}
        <button className="btn" disabled={busy}>
          Add {KINDS[form.kind].title.toLowerCase()}
        </button>
      </form>

      <section className="card">
        <h2 className="font-semibold">Your rules</h2>
        {!data?.rules.length && <p className="muted mt-2">No rules yet. Without rules, the assistant still suggests related products from your catalog.</p>}
        <ul className="mt-2 divide-y">
          {data?.rules.map((r: any) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className={r.active ? '' : 'opacity-50'}>
                <div className="text-sm font-semibold">
                  {r.name} <span className="muted font-normal">· {KINDS[r.kind as Kind].title}</span>
                  {r.ends_at && new Date(r.ends_at) < new Date() && <span className="ml-2 text-xs text-amber-700">Ended</span>}
                </div>
                <div className="muted">{describe(r)}</div>
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => toggle(r)}>
                  {r.active ? 'Pause' : 'Resume'}
                </button>
                <button className="btn-danger" onClick={() => remove(r.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
