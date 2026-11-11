// Participações (Fase 2): pedidos do investidor + aprovação admin.
// Camada de dados (REST/Storage/RPC) + UI (modal de participação, página Meus Contratos, painel admin).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { accessToken, currentUser } from './auth.js?v=v9';

const REST = SUPABASE_URL + '/rest/v1';
const STORAGE = SUPABASE_URL + '/storage/v1';
const h = (extra = {}) => ({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || SUPABASE_ANON_KEY), ...extra });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dt = (iso) => { try { return new Date(iso).toLocaleDateString('pt-BR'); } catch { return ''; } };

// ---------- Dados ----------
export async function loadParticipationConfig() {
  try {
    const r = await fetch(REST + '/app_settings?select=key,value', { headers: h() });
    if (!r.ok) return { deposit: {}, contract: '' };
    const rows = await r.json(); const map = {};
    for (const row of rows) map[row.key] = row.value || {};
    return { deposit: map.deposit_account || {}, contract: (map.contract_template || {}).texto || '' };
  } catch { return { deposit: {}, contract: '' }; }
}

export async function uploadComprovante(file) {
  const u = currentUser(); if (!u) throw new Error('Faça login para enviar o comprovante.');
  const ext = (String(file.name || '').split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const path = u.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const r = await fetch(STORAGE + '/object/comprovantes/' + path, {
    method: 'POST', headers: h({ 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }), body: file,
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro no upload (' + r.status + ')'));
  return path;
}

export async function createParticipationRequest(payload) {
  const r = await fetch(REST + '/participation_requests', {
    method: 'POST', headers: h({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
  return (await r.json())[0];
}

export async function myRequests() {
  const r = await fetch(REST + '/participation_requests?select=*&order=created_at.desc', { headers: h() });
  if (!r.ok) return [];
  return r.json();
}

export async function allRequests(status) {
  const q = status ? '&status=eq.' + status : '';
  const r = await fetch(REST + '/participation_requests?select=*&order=created_at.desc' + q, { headers: h() });
  if (!r.ok) return [];
  return r.json();
}

export async function approveRequest(id) {
  const r = await fetch(REST + '/rpc/approve_participation_request', {
    method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ p_request_id: id }),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
  return r.json();
}

export async function rejectRequest(id) {
  const r = await fetch(REST + '/participation_requests?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', headers: h({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify({ status: 'rejected' }),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

export async function comprovanteUrl(path) {
  if (!path) return null;
  try {
    const r = await fetch(STORAGE + '/object/sign/comprovantes/' + path, {
      method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!r.ok) return null;
    const b = await r.json();
    return b.signedURL ? SUPABASE_URL + '/storage/v1' + b.signedURL : null;
  } catch { return null; }
}

// ---------- Helpers de domínio ----------
const cotaCents = (o) => Number(o.token_price || (Number(o.min) ? Number(o.min) * 100 : 0) || 10000);

function fillContract(template, data) {
  const base = template || 'TERMO DE ADESÃO E SUBSCRIÇÃO DE PARTICIPAÇÃO\n\n{{nome}} (CPF {{cpf}}) subscreve {{tokens}} cota(s) do projeto {{projeto}}, no valor total de {{valor}}, em {{data}}.';
  return String(base).replace(/\{\{(\w+)\}\}/g, (_, k) => (data[k] != null && data[k] !== '' ? String(data[k]) : '____'));
}

const STATUS = {
  pending: ['Pendente', 'amber'], approved: ['Aprovado', 'green'], rejected: ['Recusado', 'red'],
};
const badge = (status) => { const [t, tone] = STATUS[status] || [status, 'navy']; return `<span class="badge badge-${tone}">${t}</span>`; };

// ---------- Modal do investidor: "Participar do projeto" ----------
// deps: { dialogEl, closeDialog, toast, icon, profile }
export function openParticipationDialog(o, deps) {
  const { dialogEl, closeDialog, toast, icon, profile } = deps;
  const u = currentUser();
  if (!u) { location.hash = '/entrar'; return; }
  const price = cotaCents(o);
  const state = { step: 1, tokens: 1, cpf: '', config: null, contractText: '', file: null, busy: false };

  function open(title, body) {
    dialogEl.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-pt-close aria-label="Fechar">${icon ? icon('close') : '✕'}</button></div><div class="dialog-body">${body}</div>`;
    if (!dialogEl.open) dialogEl.showModal();
    wire();
  }

  const total = () => price * Math.max(1, state.tokens | 0);

  function contractData() {
    return {
      nome: profile?.full_name || u.email || '', cpf: state.cpf || '', tokens: state.tokens,
      projeto: o.name || o.id, valor: brl(total()), data: new Date().toLocaleDateString('pt-BR'),
      estrutura: o.legal_structure || 'SPE', sociedade: o.razao_social || o.name || '',
      cnpj: o.cnpj || '', socio_ostensivo: o.socio_ostensivo || '',
    };
  }

  function renderStep1() {
    open('Participar · ' + esc(o.name || ''), `
      <p class="small">Cada token representa 1 cota (${brl(price)} por cota) do projeto <strong>${esc(o.name || '')}</strong>${o.legal_structure ? ' · estrutura <strong>' + esc(o.legal_structure) + '</strong>' : ''}.</p>
      <div class="field"><label for="pt-tokens">Quantas cotas?</label><input id="pt-tokens" type="number" inputmode="numeric" min="1" step="1" value="${state.tokens}"></div>
      <div class="field"><label for="pt-cpf">Seu CPF (para o contrato)</label><input id="pt-cpf" inputmode="numeric" maxlength="14" placeholder="000.000.000-00" value="${esc(state.cpf)}"></div>
      <div class="summary-line"><span>Valor por cota</span><strong>${brl(price)}</strong></div>
      <div class="summary-line"><span>Total</span><strong id="pt-total" class="num">${brl(total())}</strong></div>
      <div class="risk-note">Nenhum recurso é movimentado agora. O pagamento é combinado e confirmado manualmente; você envia o comprovante na última etapa.</div>
      <button class="btn btn-primary full mt20" data-pt-next>Ver contrato ${icon ? icon('arrow') : '→'}</button>`);
  }

  function renderStep2() {
    state.contractText = fillContract(state.config?.contract, contractData());
    open('Contrato · ' + esc(o.name || ''), `
      <p class="small">Leia o termo preenchido com seus dados. Minuta sujeita à validação jurídica.</p>
      <pre class="pt-contract" style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6;max-height:280px;overflow:auto;background:rgba(0,0,0,.04);padding:16px;border-radius:12px">${esc(state.contractText)}</pre>
      <label class="checkbox mt20"><input type="checkbox" id="pt-accept"><span>Li e aceito os termos da participação.</span></label>
      <div class="row between mt20"><button class="btn btn-outline" data-pt-back>Voltar</button><button class="btn btn-primary" data-pt-accept disabled>Aceitar e continuar</button></div>`);
  }

  function renderStep3() {
    const d = state.config?.deposit || {};
    const lines = [['Chave PIX', d.pix], ['Titular', d.titular], ['CPF/CNPJ', d.documento], ['Banco', d.banco], ['Agência', d.agencia], ['Conta', d.conta]]
      .filter(([, v]) => v).map(([k, v]) => `<div class="summary-line"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('');
    open('Depósito e comprovante', `
      <p class="small">Faça o PIX/depósito de <strong>${brl(total())}</strong> na conta abaixo e anexe o comprovante. O admin confirma e emite suas cotas.</p>
      <div class="panel" style="padding:14px;margin:12px 0">${lines || '<p class="small">A conta de depósito ainda não foi configurada pelo admin. Combine o pagamento pelo canal informado.</p>'}${d.instrucoes ? `<p class="small" style="margin-top:8px">${esc(d.instrucoes)}</p>` : ''}</div>
      <div class="field"><label for="pt-file">Comprovante (imagem ou PDF)</label><input id="pt-file" type="file" accept="image/*,application/pdf"></div>
      <div class="summary-line"><span>${state.tokens} cota(s) · ${esc(o.name || '')}</span><strong>${brl(total())}</strong></div>
      <div id="pt-msg" role="status" style="margin:10px 0"></div>
      <div class="row between mt20"><button class="btn btn-outline" data-pt-back2>Voltar</button><button class="btn btn-primary" data-pt-submit>Enviar pedido ${icon ? icon('arrow') : '→'}</button></div>`);
  }

  function renderDone(req) {
    open('Pedido enviado', `
      <div style="text-align:center;padding:12px 0">
        <p style="font-size:42px;margin:0">✅</p>
        <h3>Pedido registrado!</h3>
        <p class="small">Seu pedido de <strong>${state.tokens} cota(s)</strong> em <strong>${esc(o.name || '')}</strong> (${brl(total())}) foi enviado e está <strong>pendente</strong> de aprovação. Você acompanha em “Meus Contratos”.</p>
        <div class="row" style="justify-content:center;gap:10px;margin-top:16px"><a class="btn btn-dark" href="#/app/contratos" data-pt-close>Ver meus contratos</a><button class="btn btn-outline" data-pt-close>Fechar</button></div>
      </div>`);
  }

  function wire() {
    dialogEl.querySelectorAll('[data-pt-close]').forEach((b) => b.addEventListener('click', () => closeDialog()));
    const tokens = dialogEl.querySelector('#pt-tokens');
    if (tokens) tokens.addEventListener('input', () => { state.tokens = Math.max(1, parseInt(tokens.value || '1', 10) || 1); const t = dialogEl.querySelector('#pt-total'); if (t) t.textContent = brl(total()); });
    const cpf = dialogEl.querySelector('#pt-cpf');
    if (cpf) cpf.addEventListener('input', () => { state.cpf = cpf.value; });
    const next = dialogEl.querySelector('[data-pt-next]');
    if (next) next.addEventListener('click', () => { state.tokens = Math.max(1, parseInt((dialogEl.querySelector('#pt-tokens') || {}).value || '1', 10) || 1); state.cpf = (dialogEl.querySelector('#pt-cpf') || {}).value || ''; renderStep2(); });
    const accept = dialogEl.querySelector('#pt-accept');
    if (accept) accept.addEventListener('change', () => { const b = dialogEl.querySelector('[data-pt-accept]'); if (b) b.disabled = !accept.checked; });
    const acceptBtn = dialogEl.querySelector('[data-pt-accept]');
    if (acceptBtn) acceptBtn.addEventListener('click', () => renderStep3());
    const back = dialogEl.querySelector('[data-pt-back]'); if (back) back.addEventListener('click', () => renderStep1());
    const back2 = dialogEl.querySelector('[data-pt-back2]'); if (back2) back2.addEventListener('click', () => renderStep2());
    const file = dialogEl.querySelector('#pt-file'); if (file) file.addEventListener('change', () => { state.file = file.files && file.files[0] ? file.files[0] : null; });
    const submit = dialogEl.querySelector('[data-pt-submit]');
    if (submit) submit.addEventListener('click', async () => {
      if (state.busy) return;
      const msg = dialogEl.querySelector('#pt-msg');
      state.busy = true; submit.disabled = true; msg.textContent = 'Enviando…';
      try {
        let path = null;
        if (state.file) path = await uploadComprovante(state.file);
        const req = await createParticipationRequest({
          opportunity_id: o.id, opportunity_name: o.name || null, legal_structure: o.legal_structure || null,
          tokens: state.tokens, unit_price_cents: price, amount_cents: total(),
          investor_name: profile?.full_name || u.email || null, cpf: state.cpf || null,
          accepted_terms: true, contract_text: state.contractText || fillContract(state.config?.contract, contractData()),
          comprovante_path: path,
        });
        toast && toast('Pedido de participação enviado.');
        renderDone(req);
      } catch (err) {
        msg.innerHTML = `<span class="form-error">${esc(err.message || 'Erro ao enviar.')}</span>`;
        state.busy = false; submit.disabled = false;
      }
    });
  }

  // Carrega config (conta de depósito + contrato) e abre.
  open('Participar · ' + esc(o.name || ''), '<p class="small">Carregando…</p>');
  loadParticipationConfig().then((cfg) => { state.config = cfg; renderStep1(); });
}

// ---------- Investidor: página "Meus Contratos" ----------
export function contratosBody() {
  return `<div id="contratos-root">
    <div class="app-heading"><div><span class="eyebrow">Participações</span><h1>Meus Contratos</h1><p>Seus pedidos de participação e suas cotas por projeto.</p></div><a class="btn btn-dark btn-sm" href="#/app/oportunidades">Ver oportunidades</a></div>
    <div id="contratos-list">${loadingBlock()}</div>
  </div>`;
}
function loadingBlock() { return `<div class="empty"><h3>Carregando…</h3></div>`; }

export function mountContratos(app) {
  const root = app.querySelector('#contratos-root'); if (!root) return () => {};
  const box = root.querySelector('#contratos-list');
  (async () => {
    const rows = await myRequests();
    if (!rows.length) { box.innerHTML = `<div class="empty">${''}<h3>Nenhum pedido ainda</h3><p>Escolha um projeto e clique em “Participar do projeto”.</p><a class="btn btn-outline btn-sm" href="#/app/oportunidades">Ver oportunidades</a></div>`; return; }
    // cotas aprovadas por projeto
    const byProj = {};
    rows.filter(r => r.status === 'approved').forEach(r => { const k = r.opportunity_name || r.opportunity_id; byProj[k] = (byProj[k] || 0) + Number(r.tokens || 0); });
    const chips = Object.entries(byProj).map(([k, v]) => `<div class="stat"><span class="stat-label">${esc(k)}</span><strong class="stat-value">${v} cota(s)</strong></div>`).join('');
    const rowsHtml = rows.map(r => `<tr>
      <td><strong>${esc(r.opportunity_name || r.opportunity_id)}</strong><span class="cell-sub">${esc(r.legal_structure || '')}</span></td>
      <td class="num">${r.tokens}</td>
      <td class="num money-value">${brl(r.amount_cents)}</td>
      <td>${dt(r.created_at)}</td>
      <td>${badge(r.status)}</td>
    </tr>`).join('');
    box.innerHTML = `${chips ? `<div class="stats" style="margin-bottom:18px">${chips}</div>` : ''}
      <div class="table-wrap"><table><caption class="sr-only">Meus pedidos de participação</caption>
      <thead><tr><th>Projeto</th><th>Cotas</th><th>Valor</th><th>Data</th><th>Status</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
  })();
  return () => {};
}

// ---------- Admin: "Pedidos de Participação" ----------
export function pedidosBody() {
  return `<div id="pedidos-root">
    <div class="app-heading"><div><span class="eyebrow">Administração</span><h1>Pedidos de Participação</h1><p>Confira o comprovante e aprove para emitir as cotas na carteira do investidor.</p></div></div>
    <div id="pedidos-list">${loadingBlock()}</div>
  </div>`;
}

export function mountPedidos(app, { toast } = {}) {
  const root = app.querySelector('#pedidos-root'); if (!root) return () => {};
  const box = root.querySelector('#pedidos-list');
  const controller = new AbortController(); const { signal } = controller;

  async function render() {
    const rows = await allRequests();
    if (!rows.length) { box.innerHTML = `<div class="empty"><h3>Nenhum pedido</h3><p>Quando um investidor participar de um projeto, o pedido aparece aqui.</p></div>`; return; }
    const card = (r) => `<article class="panel" data-req="${r.id}" style="margin-bottom:14px">
      <div class="row between wrap" style="gap:12px">
        <div><span class="eyebrow">${esc(r.opportunity_name || r.opportunity_id)} · ${esc(r.legal_structure || '')}</span>
          <h3 style="margin:4px 0">${esc(r.investor_name || '—')} ${r.cpf ? '<small style="font-weight:400">· CPF ' + esc(r.cpf) + '</small>' : ''}</h3>
          <p class="small">${r.tokens} cota(s) · <strong>${brl(r.amount_cents)}</strong> · ${dt(r.created_at)} · ${badge(r.status)}</p></div>
        <div class="row" style="gap:8px;align-items:center">
          ${r.comprovante_path ? `<button class="btn btn-outline btn-sm" data-pt-view="${r.id}">Ver comprovante</button>` : '<span class="small">sem comprovante</span>'}
          ${r.status === 'pending' ? `<button class="btn btn-outline btn-sm" data-pt-reject="${r.id}">Recusar</button><button class="btn btn-primary btn-sm" data-pt-approve="${r.id}">Aprovar</button>` : ''}
        </div>
      </div><div class="pt-view-slot" style="margin-top:10px"></div></article>`;
    box.innerHTML = rows.map(card).join('');
    wire(rows);
  }

  function wire(rows) {
    box.querySelectorAll('[data-pt-approve]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Aprovar este pedido? As cotas serão creditadas na carteira do investidor.')) return;
      b.disabled = true; b.textContent = 'Aprovando…';
      try { await approveRequest(b.dataset.ptApprove); toast && toast('Pedido aprovado e cotas emitidas.'); await render(); }
      catch (err) { b.disabled = false; b.textContent = 'Aprovar'; toast && toast('Erro: ' + (err.message || '')); }
    }, { signal }));
    box.querySelectorAll('[data-pt-reject]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Recusar este pedido?')) return;
      b.disabled = true;
      try { await rejectRequest(b.dataset.ptReject); toast && toast('Pedido recusado.'); await render(); }
      catch (err) { b.disabled = false; toast && toast('Erro: ' + (err.message || '')); }
    }, { signal }));
    box.querySelectorAll('[data-pt-view]').forEach((b) => b.addEventListener('click', async () => {
      const r = rows.find((x) => x.id === b.dataset.ptView); if (!r) return;
      const slot = b.closest('[data-req]').querySelector('.pt-view-slot');
      slot.innerHTML = '<p class="small">Abrindo comprovante…</p>';
      const url = await comprovanteUrl(r.comprovante_path);
      if (!url) { slot.innerHTML = '<p class="form-error">Não foi possível abrir o comprovante.</p>'; return; }
      const isPdf = /\.pdf($|\?)/i.test(r.comprovante_path);
      slot.innerHTML = isPdf
        ? `<a class="btn btn-dark btn-sm" href="${url}" target="_blank" rel="noopener">Abrir comprovante (PDF) ↗</a>`
        : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Comprovante" style="max-width:320px;border-radius:10px;border:1px solid rgba(0,0,0,.1)"></a>`;
    }, { signal }));
  }

  render();
  return () => controller.abort();
}

// ---------- Admin: Relatórios (captado + participantes por projeto) ----------
export async function participationTotals() {
  const r = await fetch(REST + '/participation_totals?select=*', { headers: h() });
  if (!r.ok) return [];
  return r.json();
}

export function relatoriosBody() {
  return `<div id="relatorios-root">
    <div class="app-heading"><div><span class="eyebrow">Administração</span><h1>Relatórios</h1><p>Total captado e participantes por projeto (participações aprovadas).</p></div></div>
    <div id="relatorios-list">${loadingBlock()}</div>
  </div>`;
}

export function mountRelatorios(app) {
  const root = app.querySelector('#relatorios-root'); if (!root) return () => {};
  const box = root.querySelector('#relatorios-list');
  (async () => {
    const [totals, approved] = await Promise.all([participationTotals(), allRequests('approved')]);
    if (!totals.length) { box.innerHTML = `<div class="empty"><h3>Sem participações aprovadas ainda</h3><p>Quando você aprovar pedidos, os totais por projeto aparecem aqui.</p></div>`; return; }
    const byProj = {};
    approved.forEach((r) => { (byProj[r.opportunity_id] = byProj[r.opportunity_id] || []).push(r); });
    const totCap = totals.reduce((s, t) => s + Number(t.captado_cents || 0), 0);
    const totPart = new Set(approved.map((r) => r.user_id)).size;
    const totCotas = totals.reduce((s, t) => s + Number(t.cotas || 0), 0);
    const kpis = `<div class="stats" style="margin-bottom:18px">
      <div class="stat"><span class="stat-label">Total captado</span><strong class="stat-value">${brl(totCap)}</strong></div>
      <div class="stat"><span class="stat-label">Participantes</span><strong class="stat-value">${totPart}</strong></div>
      <div class="stat"><span class="stat-label">Cotas emitidas</span><strong class="stat-value">${totCotas}</strong></div></div>`;
    const cards = totals.map((t) => {
      const parts = byProj[t.opportunity_id] || [];
      const rows = parts.map((p) => `<tr><td><strong>${esc(p.investor_name || '—')}</strong>${p.cpf ? '<span class="cell-sub">CPF ' + esc(p.cpf) + '</span>' : ''}</td><td class="num">${p.tokens}</td><td class="num money-value">${brl(p.amount_cents)}</td><td>${dt(p.created_at)}</td></tr>`).join('');
      return `<section class="panel" style="margin-bottom:14px">
        <div class="row between wrap" style="gap:12px;align-items:baseline">
          <h2 style="margin:0">${esc(t.opportunity_name || t.opportunity_id)}</h2>
          <p class="small" style="margin:0"><strong>${brl(t.captado_cents)}</strong> captados · ${t.participantes} participante(s) · ${t.cotas} cota(s)</p></div>
        <details style="margin-top:10px"><summary style="cursor:pointer;font-weight:600;font-size:14px">Ver participantes</summary>
          <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Participante</th><th>Cotas</th><th>Valor</th><th>Data</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="small">Nenhum participante.</td></tr>'}</tbody></table></div></details>
      </section>`;
    }).join('');
    box.innerHTML = kpis + cards;
  })();
  return () => {};
}
