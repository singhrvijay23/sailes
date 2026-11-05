'use client';

import { useState } from 'react';
import { api, storePath } from '@/lib/api';
import { useStore } from '@/components/store';
import { Notice, PageHeader, errorText, useLoad } from '@/components/ui';

export default function CatalogPage() {
  const { reload: reloadStore } = useStore();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useLoad(() => api(storePath(`/catalog?page=${page}&q=${encodeURIComponent(q)}`)), [page, q]);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testQ, setTestQ] = useState('');
  const [test, setTest] = useState<any>(null);

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      setResult(await api(storePath('/catalog/import'), { method: 'POST', body: fd }));
      list.reload();
      await reloadStore();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(e: React.FormEvent) {
    e.preventDefault();
    setTest(await api(storePath(`/catalog/search?q=${encodeURIComponent(testQ)}`)));
  }

  const stats = list.data?.stats;
  return (
    <>
      <PageHeader title="Catalog" subtitle="SAILES only recommends products from this catalog. Platform plugins keep it in sync automatically; you can also upload a file." />

      <div className="card">
        <h2 className="font-semibold">Import products</h2>
        <p className="muted mt-1">
          CSV or JSON. Columns we understand: <code>id</code> or <code>sku</code>, <code>title</code>, <code>description</code>, <code>price</code>, <code>compare_at_price</code>, <code>brand</code>, <code>categories</code>,{' '}
          <code>tags</code>, <code>in_stock</code>, <code>stock_qty</code>, <code>rating</code>, <code>review_count</code>, <code>image_url</code>, <code>url</code>, and attributes as <code>attr:flavor</code>, <code>attr:size</code>…
          Re-uploading updates existing products by id.
        </p>
        <label className="btn mt-4 cursor-pointer">
          {busy ? 'Importing…' : 'Choose file'}
          <input type="file" accept=".csv,.json,text/csv,application/json" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {err && (
          <div className="mt-4">
            <Notice kind="error">{err}</Notice>
          </div>
        )}
        {result && (
          <div className="mt-4 space-y-2">
            <Notice kind={result.rejected ? 'warn' : 'success'}>
              {result.created} added, {result.updated} updated, {result.unchanged} unchanged{result.rejected ? `, ${result.rejected} rows skipped` : ''}. Search indexing runs in the background.
            </Notice>
            {result.errors?.length > 0 && (
              <ul className="muted list-disc pl-5">
                {result.errors.map((e: any) => (
                  <li key={e.row}>
                    Row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="card mt-6">
        <h2 className="font-semibold">Test search</h2>
        <p className="muted">See what the assistant&apos;s search tool finds for a shopper phrase.</p>
        <form className="mt-3 flex gap-2" onSubmit={runTest}>
          <input className="input" placeholder="e.g. vegan protein vanilla" value={testQ} onChange={(e) => setTestQ(e.target.value)} />
          <button className="btn">Search</button>
        </form>
        {test && (
          <div className="mt-3">
            <p className="muted">
              {test.total} strong matches, {test.candidates} candidates. {test.facets?.length ? `Best follow-up question: ${test.facets[0].attribute}` : ''}
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              {test.items.map((p: any) => (
                <li key={p.id}>
                  {p.title} <span className="muted">· ${p.price} · score {p.score.toFixed(4)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <div className="card mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">
            Products {stats && <span className="muted font-normal">· {stats.products} total, {stats.in_stock} in stock{stats.pending_embeddings ? `, ${stats.pending_embeddings} indexing` : ''}</span>}
          </h2>
          <input
            className="input max-w-xs"
            placeholder="Filter by title, id or brand"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Categories</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((p: any) => (
                <tr key={p.id}>
                  <td className="font-mono text-xs">{p.id}</td>
                  <td>{p.title}</td>
                  <td>{p.price != null ? `$${p.price.toFixed(2)}` : '-'}</td>
                  <td>{p.in_stock ? <span className="pill bg-emerald-50 text-emerald-700">In stock</span> : <span className="pill">Out</span>}</td>
                  <td className="muted">{p.categories.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data && list.data.total === 0 && <p className="muted py-4">No products yet.</p>}
        </div>
        {list.data && list.data.total > 25 && (
          <div className="mt-3 flex items-center gap-2">
            <button className="btn-ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="muted">
              Page {page} of {Math.ceil(list.data.total / 25)}
            </span>
            <button className="btn-ghost" disabled={page * 25 >= list.data.total} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
