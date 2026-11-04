'use client';

import Link from 'next/link';
import { useStore } from '@/components/store';
import { Notice, PageHeader, Stat } from '@/components/ui';

export default function Overview() {
  const { data } = useStore();
  if (!data) return null;
  const steps = [
    { done: data.catalog.products > 0, label: 'Import your products', href: '/catalog' },
    { done: data.store.ai_mode !== 'demo', label: 'Connect your AI key (OpenAI, Gemini or Claude)', href: '/ai' },
    { done: Boolean(data.store.settings?.greeting && data.store.settings?.assistantName), label: 'Name your assistant and pick its colors', href: '/appearance' },
    { done: false, label: 'Try it in the test chat', href: '/test' },
    { done: false, label: 'Add the script tag to your site', href: '/install' },
  ];
  const trialDays = data.store.trial_ends_at ? Math.ceil((new Date(data.store.trial_ends_at).getTime() - Date.now()) / 86400000) : null;

  return (
    <>
      <PageHeader title={data.store.name} subtitle={`${data.plan.name} plan${trialDays && trialDays > 0 ? ` · free trial, ${trialDays} days left` : ''}`} />
      <div className="space-y-4">
        {data.usage.overConversationLimit && (
          <Notice kind="warn">
            You have used more than your {data.plan.conversationsPerMonth.toLocaleString('en-US')} conversations this month. Your assistant keeps working; upgrade to stay within your plan.
          </Notice>
        )}
        {data.usage.overBudget && (
          <Notice kind="warn">Your monthly AI budget is used up, so the assistant is answering with keyword search only. Raise the budget on the AI connection page.</Notice>
        )}
        {data.store.ai_mode === 'demo' && <Notice>Your assistant is running in demo mode (rule-based, no AI cost). Connect an AI key for full conversations.</Notice>}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Conversations this month" value={data.usage.conversations.toLocaleString('en-US')} hint={`of ${data.plan.conversationsPerMonth.toLocaleString('en-US')} in your plan`} />
        <Stat label="Products indexed" value={data.catalog.products.toLocaleString('en-US')} hint={data.catalog.pending_embeddings ? `${data.catalog.pending_embeddings} still indexing` : `limit ${data.plan.productsIndexed.toLocaleString('en-US')}`} />
        <Stat label="AI spend this month" value={`$${data.usage.cost_usd.toFixed(2)}`} hint={`budget $${data.usage.budgetUsd.toFixed(0)} (estimate)`} />
        <Stat label="AI provider" value={data.ai ? data.ai.provider : data.store.ai_mode === 'managed' ? 'SAILES AI' : 'Demo'} hint={data.ai?.chat_model} />
      </div>

      <div className="card mt-6">
        <h2 className="font-semibold">Get live in 15 minutes</h2>
        <ol className="mt-3 space-y-2">
          {steps.map((s, i) => (
            <li key={s.href} className="flex items-center gap-3">
              <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${s.done ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'}`}>{s.done ? '✓' : i + 1}</span>
              <Link href={s.href} className={`text-sm ${s.done ? 'text-slate-500 line-through' : 'font-medium text-navy hover:underline'}`}>
                {s.label}
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
