'use client';

import { useEffect, useState } from 'react';
import { api, session } from '@/lib/api';
import { Notice, errorText } from '@/components/ui';
import { AuthShell } from '@/components/brand';

const PLATFORM_NAMES: Record<string, string> = { woocommerce: 'WooCommerce', shopify: 'Shopify', wix: 'Wix', webflow: 'Webflow' };

interface Params {
  platform: string;
  shop: string;
  redirectUri: string;
  state: string;
}

function readParams(): Params | null {
  const q = new URLSearchParams(window.location.search);
  const p = { platform: q.get('platform') ?? '', shop: q.get('shop') ?? '', redirectUri: q.get('redirect_uri') ?? '', state: q.get('state') ?? '' };
  if (!PLATFORM_NAMES[p.platform] || !p.shop || !p.redirectUri || !p.state) return null;
  try {
    new URL(p.shop);
    new URL(p.redirectUri);
  } catch {
    return null;
  }
  return p;
}

/**
 * Install flow step 2: a platform connector (WordPress plugin, Shopify/Wix/Webflow app) sends the
 * merchant here. They sign in or sign up, pick a store, approve, and go back with a one-time code.
 */
export default function ConnectPage() {
  const [params, setParams] = useState<Params | null | undefined>(undefined);
  const [stores, setStores] = useState<Array<{ id: string; name: string; plan: string }>>([]);
  const [storeId, setStoreId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = typeof window === 'undefined' ? '' : window.location.pathname + window.location.search;

  useEffect(() => {
    const p = readParams();
    setParams(p);
    if (!p) return;
    if (!session.token) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    api('/v1/me')
      .then((me) => {
        setStores(me.stores);
        setStoreId(me.stores.find((s: any) => s.id === session.storeId)?.id ?? me.stores[0]?.id ?? '');
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  async function approve() {
    if (!params) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/v1/stores/${storeId}/connect/approve`, { method: 'POST', json: { platform: params.platform, shopUrl: params.shop, redirectUri: params.redirectUri, state: params.state } });
      session.storeId = storeId;
      window.location.href = r.redirect;
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  if (params === undefined) return null;
  if (params === null) {
    return (
      <AuthShell title="Connect your store">
        <Notice kind="error">This connection link is incomplete. Start again from the SAILES app in your store&apos;s admin.</Notice>
      </AuthShell>
    );
  }

  const platform = PLATFORM_NAMES[params.platform];
  const shopHost = new URL(params.shop).host;
  const backHost = new URL(params.redirectUri).host;
  return (
    <AuthShell title={`Connect ${platform} to SAILES`}>
      <div className="space-y-4">
        {error && <Notice kind="error">{error}</Notice>}
        <p className="text-sm">
          <strong>{shopHost}</strong> wants to connect to your SAILES store. Once connected, the {platform} app can:
        </p>
        <ul className="muted list-disc space-y-1 pl-5">
          <li>Keep your product catalog, stock and store policies in sync</li>
          <li>Show the SAILES assistant on your storefront</li>
          <li>Report orders so you can see sales from chat</li>
        </ul>
        <p className="muted">It cannot see your AI keys, billing or account details.</p>
        {stores.length > 1 && (
          <div>
            <label className="label" htmlFor="store">SAILES store</label>
            <select id="store" className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {stores.length === 1 && <p className="text-sm">SAILES store: <strong>{stores[0].name}</strong></p>}
        <button className="btn w-full" disabled={busy || !storeId} onClick={approve}>
          {busy ? 'Connecting…' : `Allow and return to ${backHost}`}
        </button>
        <p className="muted text-center">
          Not you?{' '}
          <button
            className="underline"
            onClick={() => {
              session.token = null;
              session.storeId = null;
              window.location.href = `/login?next=${encodeURIComponent(here)}`;
            }}
          >
            Use another account
          </button>{' '}
          or{' '}
          <a className="underline" href={`/signup?next=${encodeURIComponent(here)}`}>
            create a new store
          </a>
        </p>
      </div>
    </AuthShell>
  );
}
