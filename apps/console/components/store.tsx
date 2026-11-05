'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { api, session } from '@/lib/api';

export interface StoreData {
  store: { id: string; name: string; site_url: string | null; platform: string; plan: string; trial_ends_at: string | null; settings: Record<string, any>; ai_mode: 'demo' | 'byok' | 'managed'; monthly_budget_usd: number };
  plan: { id: string; name: string; conversationsPerMonth: number; productsIndexed: number; upsellRules: boolean };
  catalog: { products: number; in_stock: number; pending_embeddings: number; last_updated: string | null };
  usage: { conversations: number; cost_usd: number; input_tokens: number; output_tokens: number; conversationLimit: number; overConversationLimit: boolean; budgetUsd: number; overBudget: boolean };
  ai: { provider: string; chat_model: string; key: string; validated_at: string } | null;
  widgetKeys: Array<{ key: string; allowed_origins: string[] }>;
  embedSnippet: string | null;
}

interface Ctx {
  data: StoreData | null;
  stores: Array<{ id: string; name: string; plan: string }>;
  reload: () => Promise<void>;
  switchStore: (id: string) => void;
}

const StoreContext = createContext<Ctx>({ data: null, stores: [], reload: async () => {}, switchStore: () => {} });

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<StoreData | null>(null);
  const [stores, setStores] = useState<Ctx['stores']>([]);

  async function reload() {
    const me = await api('/v1/me');
    setStores(me.stores);
    if (!session.storeId || !me.stores.some((s: any) => s.id === session.storeId)) session.storeId = me.stores[0]?.id ?? null;
    if (session.storeId) setData(await api(`/v1/stores/${session.storeId}`));
  }

  useEffect(() => {
    if (!session.token) {
      window.location.href = '/login';
      return;
    }
    void reload();
  }, []);

  return (
    <StoreContext.Provider
      value={{
        data,
        stores,
        reload,
        switchStore: (id) => {
          session.storeId = id;
          setData(null);
          void reload();
        },
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export const useStore = () => useContext(StoreContext);
