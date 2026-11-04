'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, nextPath, session } from '@/lib/api';
import { Notice, errorText } from '@/components/ui';
import { AuthShell } from '@/components/brand';

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '', storeName: '', siteUrl: '', platform: 'custom' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qs, setQs] = useState('');
  useEffect(() => setQs(window.location.search), []);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/v1/auth/signup', { method: 'POST', json: { ...form, siteUrl: form.siteUrl || undefined } });
      session.token = r.token;
      session.storeId = r.storeId;
      router.push(nextPath());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Start your free trial">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="name">Your name</label>
            <input id="name" className="input" value={form.name} onChange={set('name')} />
          </div>
          <div>
            <label className="label" htmlFor="storeName">Store name</label>
            <input id="storeName" className="input" required value={form.storeName} onChange={set('storeName')} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="siteUrl">Store website</label>
          <input id="siteUrl" className="input" type="url" placeholder="https://yourstore.com" value={form.siteUrl} onChange={set('siteUrl')} />
        </div>
        <div>
          <label className="label" htmlFor="platform">Platform</label>
          <select id="platform" className="input" value={form.platform} onChange={set('platform')}>
            <option value="custom">Other / custom site</option>
            <option value="woocommerce">WordPress + WooCommerce</option>
            <option value="shopify">Shopify</option>
            <option value="wix">Wix</option>
            <option value="webflow">Webflow</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="email">Work email</label>
          <input id="email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password (8+ characters)</label>
          <input id="password" className="input" type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={set('password')} />
        </div>
        <button className="btn w-full" disabled={busy}>{busy ? 'Creating your store…' : 'Create account'}</button>
        <p className="muted text-center">
          Already have an account? <Link className="font-medium text-navy underline" href={`/login${qs}`}>Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
