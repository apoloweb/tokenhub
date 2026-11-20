// Fatia 3: carrega a carteira do usuário logado do Supabase e injeta no modelo (somente leitura).
// Visitante (sem login) mantém a carteira de exemplo.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { currentUser, accessToken } from './auth.js?v=v9';
import { exampleWalletData, replaceWalletData } from './wallet-model.js?v=wallet-model-v1';

const REST = SUPABASE_URL + '/rest/v1';

function headers() {
  const t = accessToken();
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + (t || SUPABASE_ANON_KEY),
    'Content-Type': 'application/json',
  };
}

async function fetchAssets() {
  const r = await fetch(REST + '/wallet_assets?select=id,symbol,network,decimals,mark,tone,price_cents&order=sort_order.asc', { headers: headers() });
  if (!r.ok) throw new Error('wallet_assets ' + r.status);
  return (await r.json()).map(a => ({
    id: a.id, symbol: a.symbol, network: a.network, decimals: Number(a.decimals),
    mark: a.mark, tone: a.tone, priceCents: Number(a.price_cents),
  }));
}

async function fetchEntries() {
  const r = await fetch(REST + '/wallet_entries?select=entry_id,date,kind,asset_id,units,project_id,status,name&order=date.asc', { headers: headers() });
  if (!r.ok) throw new Error('wallet_entries ' + r.status);
  return (await r.json()).map(e => ({
    id: e.entry_id, date: e.date, kind: e.kind, assetId: e.asset_id,
    units: Number(e.units), status: e.status, name: e.name,
    ...(e.project_id ? { projectId: e.project_id } : {}),
  }));
}

// Sincroniza o modelo da carteira com o estado atual (logado => banco; visitante => exemplo).
// O participante só LÊ a própria carteira: os lançamentos entram pela aprovação de um pedido
// de participação (admin). Conta nova começa com a carteira vazia.
export async function syncWallet() {
  const u = currentUser();
  if (!u) { replaceWalletData(exampleWalletData); return; }
  const [assets, entries] = await Promise.all([fetchAssets(), fetchEntries()]);
  const asOf = entries.reduce((m, e) => (e.date > m ? e.date : m), new Date().toISOString().slice(0, 10));
  replaceWalletData({ schemaVersion: 1, asOf, assets, entries });
}

export function resetWalletToExample() { replaceWalletData(exampleWalletData); }
