'use client';

import { API_URL } from '@/lib/api';
import { useStore } from '@/components/store';
import { PageHeader } from '@/components/ui';

export default function TestChatPage() {
  const { data } = useStore();
  const key = data?.widgetKeys[0]?.key;
  return (
    <>
      <PageHeader title="Test chat" subtitle="This is your live assistant, exactly as shoppers will see it. Test chats count as conversations." />
      {key ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <iframe title="SAILES test chat" className="h-[640px] w-full rounded-xl border border-slate-200 bg-white" src={`${API_URL}/demo/?key=${encodeURIComponent(key)}&inline=1`} />
          <div className="card h-fit text-sm">
            <h2 className="font-semibold">Things to try</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
              <li>A vague request, to see the counter-question</li>
              <li>A budget: &quot;under $40&quot;</li>
              <li>An exclusion: &quot;no soy&quot;, &quot;not leather&quot;</li>
              <li>A product you don&apos;t sell, to see recovery</li>
              <li>&quot;What&apos;s your return policy?&quot;</li>
              <li>&quot;Compare the first two&quot;</li>
            </ul>
            <p className="muted mt-3">Mode: {data.store.ai_mode === 'demo' ? 'demo (rule-based)' : data.ai ? `${data.ai.provider} · ${data.ai.chat_model}` : data.store.ai_mode}</p>
          </div>
        </div>
      ) : (
        <p className="muted">No widget key found for this store.</p>
      )}
    </>
  );
}
