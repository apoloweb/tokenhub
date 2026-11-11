// Admin: Ambiente de demonstração — remover/recriar os dados fictícios.
// Usa as policies existentes (admin escreve opportunities; dono escreve wallet_entries). Sem SQL novo.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { accessToken, currentUser } from './auth.js?v=v9';
import { exampleWalletData } from './wallet-model.js?v=wallet-model-v1';

const REST = SUPABASE_URL + '/rest/v1';
const h = (extra = {}) => ({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || SUPABASE_ANON_KEY), ...extra });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DEMO_IDS = ['reserva', 'solar', 'agro', 'recebiveis'];
const DEMO_ROWS = [
  { id: 'reserva', name: 'Reserva Urbana', issuer: 'Projeto imobiliário demonstrativo', category: 'Imobiliário', rate: 16.8, term: 24, min: 500, raised: 1240000, goal: 2000000, progress: 62, remaining: 21, risk: 'Alto', art: 'urban', description: 'Uma proposta de desenvolvimento residencial, apresentada para demonstrar como avaliar uma oferta imobiliária. Números fictícios.', sort_order: 1 },
  { id: 'solar', name: 'Horizonte Solar', issuer: 'Projeto de energia demonstrativo', category: 'Energia', rate: 15.2, term: 18, min: 250, raised: 780000, goal: 1000000, progress: 78, remaining: 12, risk: 'Alto', art: 'solar', description: 'Projeto ilustrativo de geração de energia solar. Demonstra indicadores, documentos e riscos de um ativo.', sort_order: 2 },
  { id: 'agro', name: 'Ciclo do Campo', issuer: 'Projeto do agronegócio demonstrativo', category: 'Agronegócio', rate: 14.4, term: 12, min: 100, raised: 360000, goal: 1500000, progress: 24, remaining: 30, risk: 'Alto', art: 'agro', description: 'Operação fictícia ligada à cadeia do agronegócio, criada para revisão da experiência TokenHub.', sort_order: 3 },
  { id: 'recebiveis', name: 'Fluxo Empresas', issuer: 'Projeto de recebíveis demonstrativo', category: 'Recebíveis', rate: 13.8, term: 9, min: 100, raised: 690000, goal: 1200000, progress: 57.5, remaining: 18, risk: 'Alto', art: 'flow', description: 'Estrutura demonstrativa de recebíveis empresariais. A análise real dependeria de contratos e garantias.', sort_order: 4 },
];

async function removeDemoProjects() {
  const r = await fetch(REST + '/opportunities?id=in.(' + DEMO_IDS.join(',') + ')', {
    method: 'DELETE', headers: h({ Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

async function recreateDemoProjects() {
  const r = await fetch(REST + '/opportunities', {
    method: 'POST', headers: h({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(DEMO_ROWS),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

async function deleteMyEntries(uid) {
  const r = await fetch(REST + '/wallet_entries?user_id=eq.' + encodeURIComponent(uid), {
    method: 'DELETE', headers: h({ Prefer: 'return=minimal' }),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

// Zera a carteira: apaga os lançamentos e grava um sentinela de saldo 0
// (mantém a carteira não-vazia para o syncWallet não re-semear o exemplo).
async function clearMyWallet() {
  const u = currentUser(); if (!u) throw new Error('Faça login.');
  await deleteMyEntries(u.id);
  const r = await fetch(REST + '/wallet_entries', {
    method: 'POST', headers: h({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify([{ user_id: u.id, entry_id: 'cleared', date: new Date().toISOString().slice(0, 10), kind: 'deposit', asset_id: 'brl', units: 0, status: 'posted', name: 'Carteira zerada' }]),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

async function reseedMyWallet() {
  const u = currentUser(); if (!u) throw new Error('Faça login.');
  await deleteMyEntries(u.id);
  const rows = exampleWalletData.entries.map((e) => ({ user_id: u.id, entry_id: e.id, date: e.date, kind: e.kind, asset_id: e.assetId, units: e.units, project_id: e.projectId || null, status: e.status, name: e.name }));
  const r = await fetch(REST + '/wallet_entries', {
    method: 'POST', headers: h({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

// ---------- UI ----------
export function demoBody() {
  return `<div id="demo-root">
    <div class="app-heading"><div><span class="eyebrow">Administração</span><h1>Ambiente de demonstração</h1><p>Remova os dados fictícios quando for para produção, ou recrie-os para demonstrar.</p></div></div>
    <div class="notice" style="margin-bottom:18px">${''}<div><strong>Atenção.</strong><p>Estas ações afetam o banco de dados e não têm desfazer. Use com cuidado.</p></div></div>

    <section class="panel"><h2>Projetos de demonstração</h2>
      <p class="small">Os 4 projetos fictícios (Reserva Urbana, Horizonte Solar, Ciclo do Campo, Fluxo Empresas). <strong>Seus imóveis reais não são afetados.</strong></p>
      <div class="row" style="gap:10px;margin-top:12px">
        <button class="btn btn-outline" data-demo="recreate">Recriar projetos demo</button>
        <button class="btn btn-outline" style="color:#c0392b;border-color:#c0392b" data-demo="remove">Remover projetos demo</button>
      </div>
      <p id="demo-proj-msg" role="status" class="small" style="margin-top:10px"></p>
    </section>

    <section class="panel" style="margin-top:20px"><h2>Minha carteira (demo)</h2>
      <p class="small">Zera o saldo fictício da <strong>sua</strong> conta (a carteira seed de ~R$127 mil) ou recarrega os valores de exemplo.</p>
      <div class="row" style="gap:10px;margin-top:12px">
        <button class="btn btn-outline" data-demo="reseed">Recarregar carteira exemplo</button>
        <button class="btn btn-outline" style="color:#c0392b;border-color:#c0392b" data-demo="clear">Zerar minha carteira</button>
      </div>
      <p id="demo-wallet-msg" role="status" class="small" style="margin-top:10px"></p>
    </section>
  </div>`;
}

// deps: { toast, offers, reloadOpportunities, syncWallet }
export function mountDemo(app, { toast, offers, reloadOpportunities, syncWallet } = {}) {
  const root = app.querySelector('#demo-root'); if (!root) return () => {};
  const controller = new AbortController(); const { signal } = controller;
  const pending = {}; // 2-cliques por ação destrutiva

  async function run(action, btn) {
    const projMsg = root.querySelector('#demo-proj-msg');
    const walletMsg = root.querySelector('#demo-wallet-msg');
    const msg = (action === 'remove' || action === 'recreate') ? projMsg : walletMsg;
    const destructive = (action === 'remove' || action === 'clear');
    const label = btn.textContent;

    if (destructive && !pending[action]) {
      pending[action] = true; btn.classList.add('active'); btn.textContent = 'Confirmar?';
      setTimeout(() => { if (pending[action]) { pending[action] = false; btn.classList.remove('active'); btn.textContent = label; } }, 4000);
      return;
    }
    pending[action] = false;
    btn.disabled = true; const orig = btn.textContent.replace('Confirmar?', label); btn.textContent = 'Processando…'; msg.textContent = '';
    try {
      if (action === 'remove') { await removeDemoProjects(); reloadOpportunities && await reloadOpportunities(); msg.innerHTML = '<span class="form-success">Projetos de demonstração removidos.</span>'; toast && toast('Projetos demo removidos.'); }
      if (action === 'recreate') { await recreateDemoProjects(); reloadOpportunities && await reloadOpportunities(); msg.innerHTML = '<span class="form-success">Projetos de demonstração recriados.</span>'; toast && toast('Projetos demo recriados.'); }
      if (action === 'clear') { await clearMyWallet(); syncWallet && await syncWallet(); msg.innerHTML = '<span class="form-success">Carteira zerada.</span>'; toast && toast('Carteira zerada.'); }
      if (action === 'reseed') { await reseedMyWallet(); syncWallet && await syncWallet(); msg.innerHTML = '<span class="form-success">Carteira de exemplo recarregada.</span>'; toast && toast('Carteira de exemplo recarregada.'); }
    } catch (err) {
      msg.innerHTML = `<span class="form-error">${esc(err.message || 'Erro.')}</span>`;
    } finally {
      btn.disabled = false; btn.classList.remove('active'); btn.textContent = orig;
    }
  }

  root.querySelectorAll('[data-demo]').forEach((btn) => btn.addEventListener('click', () => run(btn.dataset.demo, btn), { signal }));
  return () => controller.abort();
}
