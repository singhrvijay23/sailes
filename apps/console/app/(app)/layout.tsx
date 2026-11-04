'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { StoreProvider, useStore } from '@/components/store';
import { session } from '@/lib/api';
import { Logo } from '@/components/brand';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/ai', label: 'AI connection' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/rules', label: 'Rules & answers' },
  { href: '/appearance', label: 'Assistant & look' },
  { href: '/test', label: 'Test chat' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/install', label: 'Install' },
  { href: '/billing', label: 'Billing' },
];

function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data, stores, switchStore } = useStore();
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col bg-navy p-4 text-white md:flex">
        <Logo light />
        {stores.length > 1 && (
          <select aria-label="Store" className="mt-6 w-full rounded-lg bg-navy-600 px-2 py-2 text-sm" value={data?.store.id ?? ''} onChange={(e) => switchStore(e.target.value)}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {stores.length <= 1 && <div className="mt-6 truncate text-sm font-semibold">{data?.store.name}</div>}
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`rounded-lg px-3 py-2 text-sm ${path === n.href ? 'bg-white/15 font-semibold' : 'text-white/80 hover:bg-white/10'}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="text-xs text-white/60">
          {data && (
            <p>
              {data.plan.name} plan · {data.usage.conversations.toLocaleString('en-US')}/{data.plan.conversationsPerMonth.toLocaleString('en-US')} chats
            </p>
          )}
          <button
            className="mt-2 underline"
            onClick={() => {
              session.token = null;
              session.storeId = null;
              window.location.href = '/login';
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="flex-1">
        <div className="flex items-center justify-between bg-navy px-4 py-3 md:hidden">
          <Logo light />
          <select aria-label="Page" className="rounded bg-navy-600 px-2 py-1 text-sm text-white" value={path} onChange={(e) => (window.location.href = e.target.value)}>
            {NAV.map((n) => (
              <option key={n.href} value={n.href}>
                {n.label}
              </option>
            ))}
          </select>
        </div>
        <main className="mx-auto max-w-5xl px-4 py-8 md:px-8">{data ? children : <p className="muted">Loading…</p>}</main>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <StoreProvider>
      <Shell>{children}</Shell>
    </StoreProvider>
  );
}
