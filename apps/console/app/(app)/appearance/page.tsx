'use client';

import { useEffect, useState } from 'react';
import { api, storePath } from '@/lib/api';
import { useStore } from '@/components/store';
import { Notice, PageHeader, errorText } from '@/components/ui';

export default function AppearancePage() {
  const { data, reload } = useStore();
  const [s, setS] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (data) setS({ tone: 'friendly', placement: 'bottom-right', primaryColor: '#1B2A4A', ...data.store.settings, suggestions: (data.store.settings.suggestions ?? []).join('\n') });
  }, [data?.store.id]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setS({ ...s, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const settings = {
        assistantName: s.assistantName || undefined,
        tone: s.tone,
        greeting: s.greeting || undefined,
        storeDescription: s.storeDescription || undefined,
        extraInstructions: s.extraInstructions || undefined,
        primaryColor: s.primaryColor,
        logoUrl: s.logoUrl || '',
        placement: s.placement,
        suggestions: String(s.suggestions ?? '')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 4),
      };
      await api(storePath(), { method: 'PATCH', json: { settings } });
      setMsg({ kind: 'success', text: 'Saved. Reload your site or the test chat to see changes.' });
      await reload();
    } catch (err) {
      setMsg({ kind: 'error', text: errorText(err) });
    }
  }

  return (
    <>
      <PageHeader title="Assistant & look" subtitle="Give your assistant a name, a voice and your brand colors." />
      {msg && (
        <div className="mb-4">
          <Notice kind={msg.kind}>{msg.text}</Notice>
        </div>
      )}
      <form className="card space-y-4" onSubmit={save}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="an">Assistant name</label>
            <input id="an" className="input" maxLength={60} value={s.assistantName ?? ''} onChange={set('assistantName')} />
          </div>
          <div>
            <label className="label" htmlFor="tone">Tone</label>
            <select id="tone" className="input" value={s.tone} onChange={set('tone')}>
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="playful">Playful</option>
              <option value="luxury">Luxury</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="gr">Greeting</label>
          <input id="gr" className="input" maxLength={300} value={s.greeting ?? ''} onChange={set('greeting')} />
        </div>
        <div>
          <label className="label" htmlFor="sd">What your store sells (one line)</label>
          <input id="sd" className="input" maxLength={300} placeholder="e.g. protein, supplements and home fitness gear" value={s.storeDescription ?? ''} onChange={set('storeDescription')} />
        </div>
        <div>
          <label className="label" htmlFor="sg">Starter suggestions (one per line, up to 4)</label>
          <textarea id="sg" className="input" rows={3} value={s.suggestions ?? ''} onChange={set('suggestions')} />
        </div>
        <div>
          <label className="label" htmlFor="ei">Extra instructions for the assistant</label>
          <textarea id="ei" className="input" rows={3} maxLength={1500} placeholder="e.g. Always mention our free engraving on jewelry." value={s.extraInstructions ?? ''} onChange={set('extraInstructions')} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="pc">Brand color</label>
            <div className="flex gap-2">
              <input id="pc" type="color" className="h-10 w-14 rounded border border-slate-300" value={s.primaryColor ?? '#1B2A4A'} onChange={set('primaryColor')} />
              <input className="input font-mono" aria-label="Brand color hex" value={s.primaryColor ?? ''} onChange={set('primaryColor')} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="pl">Placement</label>
            <select id="pl" className="input" value={s.placement} onChange={set('placement')}>
              <option value="bottom-right">Bubble, bottom right</option>
              <option value="bottom-left">Bubble, bottom left</option>
              <option value="inline">Inline on a page</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="lg">Logo URL</label>
            <input id="lg" className="input" type="url" value={s.logoUrl ?? ''} onChange={set('logoUrl')} />
          </div>
        </div>
        <button className="btn">Save</button>
      </form>
    </>
  );
}
