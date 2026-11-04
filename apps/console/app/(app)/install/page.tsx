'use client';

import { useState } from 'react';
import { api, storePath } from '@/lib/api';
import { useStore } from '@/components/store';
import { Notice, PageHeader, errorText, useLoad } from '@/components/ui';

export default function InstallPage() {
  const { data, reload } = useStore();
  const keys = useLoad(() => api(storePath('/api-keys')));
  const [newKey, setNewKey] = useState<string | null>(null);
  const [origins, setOrigins] = useState((data?.widgetKeys[0]?.allowed_origins ?? []).join('\n'));
  const [msg, setMsg] = useState<string | null>(null);
  const wk = data?.widgetKeys[0];

  return (
    <>
      <PageHeader title="Install" subtitle="Add SAILES to your site. WordPress, Shopify and Wix plugins do this for you." />
      <div className="card">
        <h2 className="font-semibold">1. Paste this before &lt;/body&gt; on every page</h2>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-emerald-200">{data?.embedSnippet}</pre>
        <button className="btn-ghost mt-3" onClick={() => navigator.clipboard.writeText(data?.embedSnippet ?? '')}>
          Copy snippet
        </button>
        <p className="muted mt-3">
          For an inline chat on a search page instead of the bubble, add <code>data-mode=&quot;inline&quot; data-target=&quot;#sailes-chat&quot;</code> and a <code>&lt;div id=&quot;sailes-chat&quot;&gt;</code> where it should appear.
        </p>
      </div>

      {wk && (
        <div className="card mt-6">
          <h2 className="font-semibold">2. Allowed websites</h2>
          <p className="muted">Only these sites can use your widget key, so nobody can run up your AI bill from another site. One per line. Empty allows any site (not recommended once live).</p>
          <textarea className="input mt-3 font-mono" rows={3} placeholder="https://yourstore.com" value={origins} onChange={(e) => setOrigins(e.target.value)} />
          {msg && <p className="muted mt-2">{msg}</p>}
          <button
            className="btn mt-3"
            onClick={async () => {
              try {
                await api(storePath(`/widget-keys/${wk.key}`), { method: 'PUT', json: { allowedOrigins: origins.split('\n').map((o) => o.trim()).filter(Boolean) } });
                setMsg('Saved.');
                await reload();
              } catch (e) {
                setMsg(errorText(e));
              }
            }}
          >
            Save websites
          </button>
        </div>
      )}

      <div className="card mt-6">
        <h2 className="font-semibold">Connector keys (for plugins and developers)</h2>
        <p className="muted">Secret keys let a platform plugin sync your catalog and report orders. Treat them like a password.</p>
        {newKey && (
          <div className="mt-3">
            <Notice kind="success">
              Copy this key now, it will not be shown again: <code className="break-all font-mono">{newKey}</code>
            </Notice>
          </div>
        )}
        <ul className="mt-3 divide-y divide-slate-100">
          {keys.data?.keys.map((k: any) => (
            <li key={k.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {k.name} <span className="muted font-mono">{k.prefix}…</span> <span className="muted">· last used {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString('en-US') : 'never'}</span>
              </span>
              <button
                className="btn-danger"
                onClick={async () => {
                  await api(storePath(`/api-keys/${k.id}`), { method: 'DELETE' });
                  keys.reload();
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
        <button
          className="btn-ghost mt-3"
          onClick={async () => {
            const r = await api(storePath('/api-keys'), { method: 'POST', json: { name: 'Connector' } });
            setNewKey(r.key);
            keys.reload();
          }}
        >
          Create connector key
        </button>
      </div>
    </>
  );
}
