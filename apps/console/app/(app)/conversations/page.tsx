'use client';

import { useState } from 'react';
import { api, storePath } from '@/lib/api';
import { PageHeader, useLoad } from '@/components/ui';

export default function ConversationsPage() {
  const list = useLoad(() => api(storePath('/conversations')));
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => (open ? api(storePath(`/conversations/${open}`)) : Promise.resolve(null)), [open]);

  return (
    <>
      <PageHeader title="Conversations" subtitle="Read what shoppers asked and what the assistant answered. Transcripts are kept 90 days." />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <ul className="card max-h-[70vh] divide-y divide-slate-100 overflow-y-auto p-0">
          {list.data?.items.map((c: any) => (
            <li key={c.id}>
              <button className={`w-full px-4 py-3 text-left text-sm hover:bg-slate-50 ${open === c.id ? 'bg-slate-100' : ''}`} onClick={() => setOpen(c.id)}>
                <div className="truncate font-medium">{c.first_message ?? '(no messages)'}</div>
                <div className="muted text-xs">
                  {new Date(c.last_message_at).toLocaleString('en-US')} · {c.message_count / 2} turns
                </div>
              </button>
            </li>
          ))}
          {list.data?.items.length === 0 && <li className="muted p-4">No conversations yet.</li>}
        </ul>
        <div className="card">
          {!detail.data && <p className="muted">Pick a conversation.</p>}
          {detail.data?.messages.map((m: any, i: number) => (
            <div key={i} className={`mb-3 ${m.role === 'user' ? 'text-right' : ''}`}>
              <div className={`inline-block max-w-[85%] rounded-xl px-3 py-2 text-left text-sm ${m.role === 'user' ? 'bg-navy text-white' : 'bg-slate-100'}`}>{m.content}</div>
              {m.payload?.products?.length > 0 && (
                <div className="mt-1 text-xs text-slate-500">Showed: {m.payload.products.map((p: any) => p.title).join(' · ')}</div>
              )}
              {m.payload?.question && <div className="mt-1 text-xs text-slate-500">Options: {m.payload.question.options.join(' / ')}</div>}
              {m.payload?.rejected?.length > 0 && (
                <div className="mt-1 text-xs text-amber-700">Guard blocked: {m.payload.rejected.map((r: any) => `${r.id} (${r.reason})`).join(', ')}</div>
              )}
              {m.role === 'assistant' && m.payload?.mode && <div className="mt-1 text-[11px] text-slate-400">{m.payload.mode} · {m.payload.model}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
