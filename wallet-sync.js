// Fatia 3: carrega a carteira do usuário logado do Supabase e injeta no modelo.
// Visitante (sem login) mantém a carteira de exemplo.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { currentUser, accessToken } from './auth.js?v=v8';
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

// Semeia a carteira inicial (igual ao exemplo) na primeira vez que o usuário acessa.
async function seedStarter(userId) {
  const rows = exampleWalletData.entries.map(e => ({
    user_id: userId, entry_id: e.id, date: e.date, kind: e.kind,
    asset_id: e.assetId, units: e.units, project_id: e.projectId || null,
    status: e.status, name: e.name,
  }));
  const r = await fetch(REST + '/wallet_entries', {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error('seed wallet_entries ' + r.status);
}

// Sincroniza o modelo da carteira com o estado atual (logado => banco; visitante => exemplo).
export async function syncWallet() {
  const u = currentUser();
  if (!u) { replaceWalletData(exampleWalletData); return; }
  const [assets, first] = await Promise.all([fetchAssets(), fetchEntries()]);
  let entries = first;
  if (!entries.length) { await seedStarter(u.id); entries = await fetchEntries(); }
  const asOf = entries.reduce((m, e) => (e.date > m ? e.date : m), '2026-11-09');
  replaceWalletData({ schemaVersion: 1, asOf, assets, entries });
}

export function resetWalletToExample() { replaceWalletData(exampleWalletData); }

// Grava um ou mais movimentos na carteira do usuário logado e re-sincroniza.
export async function addWalletEntries(entries) {
  const u = currentUser();
  if (!u) throw new Error('Entre na sua conta para fazer isso.');
  const rows = entries.map((e, i) => ({
    user_id: u.id,
    entry_id: e.entry_id || ('op-' + Date.now().toString(36) + '-' + i + '-' + Math.random().toString(36).slice(2, 7)),
    date: e.date || new Date().toISOString().slice(0, 10),
    kind: e.kind,
    asset_id: e.assetId,
    units: e.units,
    project_id: e.projectId || null,
    status: 'posted',
    name: e.name,
  }));
  const r = await fetch(REST + '/wallet_entries', {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
  await syncWallet();
}
