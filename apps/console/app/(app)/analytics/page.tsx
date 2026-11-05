'use client';

import { useState } from 'react';
import { api, storePath } from '@/lib/api';
import { PageHeader, Stat, useLoad } from '@/components/ui';

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const { data } = useLoad(() => api(storePath(`/analytics?days=${days}`)), [days]);
  const t = data?.totals;
  const max = Math.max(1, ...(data?.daily ?? []).map((d: any) => d.conversations));
  const ctr = t && t.impressions ? ((t.clicks / t.impressions) * 100).toFixed(1) + '%' : '-';

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="How shoppers use your assistant and what they could not find."
        actions={
          <select className="input w-40" aria-label="Range" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />
      {t && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Conversations" value={t.conversations.toLocaleString('en-US')} hint={`${t.shopper_messages} shopper messages`} />
          <Stat label="Products shown" value={t.impressions.toLocaleString('en-US')} hint={`${t.clicks} clicks · ${ctr} click rate`} />
          <Stat label="Add to carts" value={t.add_to_carts.toLocaleString('en-US')} />
          <Stat label="Attributed revenue" value={`$${t.attributed_revenue.toLocaleString('en-US', { maximumFractionDigits: 0 })}`} hint={`${t.orders} orders`} />
        </div>
      )}

      <div className="card mt-6">
        <h2 className="font-semibold">Conversations per day</h2>
        <div className="mt-4 flex h-40 items-end gap-[2px]" role="img" aria-label="Conversations per day bar chart">
          {data?.daily.map((d: any) => (
            <div key={d.day} className="group relative flex-1">
              <div className="w-full rounded-t bg-navy" style={{ height: `${(d.conversations / max) * 150}px`, minHeight: d.conversations ? 2 : 0 }} />
              <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-white group-hover:block">
                {d.day}: {d.conversations}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold">Top searches</h2>
          <table className="table mt-2">
            <tbody>
              {data?.topQueries.map((q: any) => (
                <tr key={q.query}>
                  <td>{q.query}</td>
                  <td className="text-right">{q.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.topQueries.length === 0 && <p className="muted">No searches yet.</p>}
        </div>
        <div className="card">
          <h2 className="font-semibold">Searches with no results</h2>
          <p className="muted">Demand you are missing. Add products, synonyms or policies for these.</p>
          <table className="table mt-2">
            <tbody>
              {data?.zeroResultQueries.map((q: any) => (
                <tr key={q.query}>
                  <td>{q.query}</td>
                  <td className="text-right">{q.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.zeroResultQueries.length === 0 && <p className="muted">None. Nice.</p>}
        </div>
      </div>

      <div className="card mt-6">
        <h2 className="font-semibold">Top products in chat</h2>
        <table className="table mt-2">
          <thead>
            <tr>
              <th>Product</th>
              <th className="text-right">Shown</th>
              <th className="text-right">Clicks</th>
              <th className="text-right">Add to cart</th>
            </tr>
          </thead>
          <tbody>
            {data?.topProducts.map((p: any) => (
              <tr key={p.id}>
                <td>{p.title ?? p.id}</td>
                <td className="text-right">{p.impressions}</td>
                <td className="text-right">{p.clicks}</td>
                <td className="text-right">{p.add_to_carts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
