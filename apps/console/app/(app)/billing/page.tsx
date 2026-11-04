'use client';

import { useEffect, useState } from 'react';
import { api, storePath } from '@/lib/api';
import { useStore } from '@/components/store';
import { Notice, PageHeader, errorText, useLoad } from '@/components/ui';

const STATUS: Record<string, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment failed, retrying',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
  incomplete: 'Waiting for payment',
  incomplete_expired: 'Checkout expired',
};

const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function BillingPage() {
  const { data: store, reload: reloadStore } = useStore();
  const billing = useLoad(() => (store ? api(storePath('/billing')) : Promise.resolve(null)), [store?.store.id]);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('checkout') === 'success') setMsg({ kind: 'success', text: 'Thanks! Your subscription is being set up. This page updates in a few seconds.' });
    if (q.get('credits') === 'success') setMsg({ kind: 'success', text: 'Payment received. Your credits appear in a few seconds.' });
    if (q.get('checkout') === 'success' || q.get('credits') === 'success') {
      const t = setTimeout(() => {
        billing.reload();
        reloadStore();
      }, 4000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const b = billing.data;

  async function go(key: string, path: string, json?: unknown) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await api(storePath(path), { method: 'POST', json });
      window.location.href = r.url;
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
      setBusy(null);
    }
  }

  async function devSwitch(plan: string) {
    setBusy(plan);
    try {
      await api(storePath(), { method: 'PATCH', json: { plan } });
      await Promise.all([billing.reload(), reloadStore()]);
    } catch (e) {
      setMsg({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!b) return <PageHeader title="Billing" subtitle={billing.error ?? 'Loading…'} />;

  const subscribed = b.status && !['canceled', 'incomplete_expired'].includes(b.status);
  const trialLeft = b.trialEndsAt ? Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86_400_000) : 0;

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Your SAILES plan and SAILES AI credits."
        actions={
          b.configured && b.hasCustomer ? (
            <button className="btn-ghost" disabled={busy === 'portal'} onClick={() => go('portal', '/billing/portal')}>
              Manage billing and invoices
            </button>
          ) : undefined
        }
      />
      {msg && (
        <div className="mb-4">
          <Notice kind={msg.kind}>{msg.text}</Notice>
        </div>
      )}
      {!b.configured && (
        <div className="mb-4">
          <Notice kind="info">{b.planSwitchAllowed ? 'Billing isn\u2019t connected on this server (test site). You can switch plans directly to try each tier.' : 'Billing isn\u2019t connected on this server yet.'}</Notice>
        </div>
      )}
      {!b.entitled && (
        <div className="mb-4">
          <Notice kind="error">Your free trial has ended, so the assistant is hidden on your store. Choose a plan to turn it back on.</Notice>
        </div>
      )}

      <div className="card mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">
            {store?.plan.name} plan {b.interval ? <span className="muted">· billed {b.interval === 'year' ? 'yearly' : 'monthly'}</span> : null}
          </div>
          <div className="muted">
            {subscribed
              ? `${STATUS[b.status] ?? b.status}${b.currentPeriodEnd ? ` · ${b.cancelAtPeriodEnd ? 'ends' : 'renews'} ${fmtDate(b.currentPeriodEnd)}` : ''}`
              : trialLeft > 0
                ? `Free trial · ${trialLeft} day${trialLeft === 1 ? '' : 's'} left (ends ${fmtDate(b.trialEndsAt)})`
                : 'No active subscription'}
          </div>
        </div>
        {b.configured && !subscribed && (
          <div className="flex rounded-lg border border-slate-200 p-1 text-sm" role="group" aria-label="Billing period">
            {(['month', 'year'] as const).map((i) => (
              <button key={i} className={`rounded-md px-3 py-1 ${interval === i ? 'bg-navy text-white' : 'text-slate-600'}`} onClick={() => setInterval(i)}>
                {i === 'month' ? 'Monthly' : 'Yearly (2 months free)'}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {b.plans.map((p: any) => {
          const current = p.id === b.plan && (subscribed || !b.configured);
          return (
            <div key={p.id} className={`card flex flex-col ${current ? 'border-navy ring-2 ring-navy/20' : ''}`}>
              <div className="font-semibold">{p.name}</div>
              <div className="mt-1 text-2xl font-bold">
                {usd(interval === 'year' && b.configured ? p.priceAnnualUsd : p.priceMonthlyUsd)}
                <span className="muted font-normal">/{interval === 'year' && b.configured ? 'year' : 'month'}</span>
              </div>
              <ul className="muted mt-3 flex-1 space-y-1">
                <li>{p.conversationsPerMonth.toLocaleString('en-US')} conversations a month</li>
                <li>{p.productsIndexed.toLocaleString('en-US')} products</li>
                <li>{p.analytics === 'basic' ? 'Basic analytics' : p.analytics === 'advanced' ? 'Advanced analytics' : 'Advanced analytics and export'}</li>
                <li>{p.upsellRules ? 'Upsell, bundle and discount rules' : 'Smart related-product suggestions'}</li>
                <li>
                  {p.seats} team seat{p.seats === 1 ? '' : 's'}
                  {p.multiStore ? ', multiple stores' : ''}
                </li>
              </ul>
              <div className="mt-4">
                {current ? (
                  <span className="text-sm font-semibold text-navy">Current plan</span>
                ) : !b.configured && b.planSwitchAllowed ? (
                  <button className="btn-ghost w-full" disabled={!!busy} onClick={() => devSwitch(p.id)}>
                    Switch to {p.name}
                  </button>
                ) : subscribed ? (
                  <button className="btn-ghost w-full" disabled={!!busy} onClick={() => go('portal', '/billing/portal')}>
                    Change in billing portal
                  </button>
                ) : (
                  <button className="btn w-full" disabled={!!busy} onClick={() => go(p.id, '/billing/checkout', { plan: p.id, interval })}>
                    {busy === p.id ? 'Opening checkout…' : trialLeft >= 2 ? `Start ${p.name}, pay after trial` : `Choose ${p.name}`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <h2 className="mb-1 text-lg font-semibold">SAILES AI credits</h2>
      <p className="muted mb-4">Don&apos;t have an AI key? Buy prepaid credits and SAILES supplies the AI. When credits run out, the assistant keeps answering with keyword search.</p>
      <div className="card mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="muted">Balance</div>
          <div className="text-2xl font-bold">{usd(b.credits.balanceUsd)}</div>
          <div className="muted">{b.credits.inUse ? 'In use: the assistant runs on SAILES AI.' : 'Not in use. Turn it on under AI connection.'}</div>
        </div>
      </div>
      {b.credits.managedAvailable && b.configured ? (
        <div className="grid gap-4 md:grid-cols-3">
          {b.credits.packs.map((p: any) => (
            <div key={p.id} className="card flex flex-col">
              <div className="font-semibold">{p.name}</div>
              <div className="mt-1 text-2xl font-bold">{usd(p.priceUsd)}</div>
              <div className="muted flex-1">{p.creditUsd > p.priceUsd ? `${usd(p.creditUsd)} of credit (${usd(p.creditUsd - p.priceUsd)} bonus)` : `${usd(p.creditUsd)} of credit`}</div>
              <button className="btn mt-4" disabled={!!busy} onClick={() => go(`pack-${p.id}`, '/billing/credits', { pack: p.id })}>
                {busy === `pack-${p.id}` ? 'Opening checkout…' : 'Buy'}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Notice kind="info">Credit purchases open once SAILES AI is enabled on this server.</Notice>
      )}
    </>
  );
}
