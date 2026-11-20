// BRLZX — área do cliente (#/app/brlzx) e backoffice da emissora e da proprietária (#/app/brlzx/backoffice).
// Banco: db/brlzx.sql. Contrato: blockchain/contracts/StablecoinBRL.sol.
// Nenhuma chave privada passa por aqui: as transações são assinadas na carteira do navegador de quem opera.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { accessToken, currentUser, ensureFreshSession } from './auth.js?v=v9';
import {
  ABI, NETWORKS, PAYMENT_METHODS, ORG_LABEL, STATUS, esc, isAddress, isTx, shortHex, fmtBRL, parseBRL,
  centsToUnits, unitsToCents, nextAction, waitingOn, canReject, isOpen, mintPath, coverageState, fmtCountdown,
  contractErrorMessage,
} from './brlzx-core.js?v=brlzx-v1';

// ───────────── Supabase (REST) ─────────────
const headers = (extra = {}) => ({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || SUPABASE_ANON_KEY), ...extra });

async function parse(r) {
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  if (!r.ok) throw new Error(json?.message || json?.error || text || ('Erro ' + r.status));
  return json;
}
async function rest(path) {
  await ensureFreshSession();
  return parse(await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: headers() }));
}
async function rpc(fn, args = {}) {
  await ensureFreshSession();
  return parse(await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(args),
  }));
}

// ───────────── Rede (ethers carregado só nestas telas) ─────────────
let ethersLib = null;
const eth = async () => (ethersLib ||= await import('./vendor/ethers/ethers.min.js'));

function chainOf(settings) {
  const net = NETWORKS[settings?.chain_id];
  if (!settings?.contract_address || !net) return null;
  return { ...net, chainId: settings.chain_id, address: settings.contract_address };
}

async function reader(settings) {
  const chain = chainOf(settings);
  if (!chain) throw new Error('O contrato ainda não está configurado.');
  const { JsonRpcProvider, Contract } = await eth();
  const provider = new JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  return { provider, contract: new Contract(chain.address, ABI, provider) };
}

async function writer(settings) {
  const chain = chainOf(settings);
  if (!chain) throw new Error('O contrato ainda não está configurado.');
  if (!window.ethereum) throw new Error('Nenhuma carteira encontrada neste navegador. Abra em um navegador com MetaMask (ou similar) ou informe o hash manualmente.');
  const { BrowserProvider, Contract } = await eth();
  let provider = new BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  if (Number((await provider.getNetwork()).chainId) !== chain.chainId) {
    try { await provider.send('wallet_switchEthereumChain', [{ chainId: '0x' + chain.chainId.toString(16) }]); }
    catch { throw new Error(`Troque a rede da carteira para ${chain.name} e tente de novo.`); }
    provider = new BrowserProvider(window.ethereum);
  }
  const signer = await provider.getSigner();
  return { contract: new Contract(chain.address, ABI, signer), address: (await signer.getAddress()).toLowerCase() };
}

function chainError(e) {
  const known = contractErrorMessage(e?.revert?.name);
  if (known) return known;
  if (e?.code === 'ACTION_REJECTED') return 'Assinatura cancelada na carteira.';
  if (e?.code === 'INSUFFICIENT_FUNDS') return 'A carteira não tem saldo para pagar a taxa da rede.';
  return e?.shortMessage || e?.message || 'Falha na transação.';
}

// Envia a transação e espera a confirmação. Devolve o hash.
async function sendTx(settings, build) {
  let tx;
  try {
    const w = await writer(settings);
    tx = await build(w.contract, w);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('A transação foi incluída, mas falhou na rede.');
  } catch (e) { throw new Error(chainError(e)); }
  return tx.hash.toLowerCase();
}

// Confere na rede se o hash é mesmo uma transferência do cliente para a tesouraria, no valor da ordem.
async function verifyDeposit(settings, order, hash) {
  const { provider, contract } = await reader(settings);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return 'Transação não encontrada na rede (ainda não confirmada ou hash de outra rede).';
  if (receipt.status !== 1) return 'A transação falhou na rede.';
  const treasury = (settings.treasury_address || '').toLowerCase();
  const need = centsToUnits(order.amount_cents);
  const token = settings.contract_address.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue;
    let ev = null;
    try { ev = contract.interface.parseLog(log); } catch { continue; }
    if (ev?.name !== 'Transfer') continue;
    if (ev.args.from.toLowerCase() === order.wallet_address && ev.args.to.toLowerCase() === treasury && ev.args.value >= need) return null;
  }
  return 'A transação não é uma transferência de BRLZX da carteira do cliente para a tesouraria no valor da ordem.';
}

// ───────────── Apresentação ─────────────
const dt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const badge = (status) => { const [label, tone] = STATUS[status] || [status, 'blue']; return `<span class="badge badge-${tone}">${esc(label)}</span>`; };
const unitsBRL = (units) => fmtBRL(unitsToCents(units)).replace('R$', '').trim() + ' BRLZX';
const txLink = (settings, hash, label) => {
  if (!hash) return '';
  const net = NETWORKS[settings?.chain_id];
  const text = `${esc(label)} ${esc(shortHex(hash, 8, 6))}`;
  return net ? `<a href="${net.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">${text}</a>` : text;
};
const loading = (text = 'Carregando…') => `<p class="small" role="status">${esc(text)}</p>`;

function injectStyle() {
  if (document.querySelector('#brlzx-style')) return;
  const el = document.createElement('style');
  el.id = 'brlzx-style';
  el.textContent = `
#brlzx-root .panel{margin-bottom:18px}
#brlzx-root h2{margin:0 0 6px;font-size:22px;line-height:1.25}
#brlzx-root p{margin:0 0 12px}
#brlzx-root form{margin-top:14px}
#brlzx-root .brlzx-alert p{margin:8px 0 0}
#brlzx-root .brlzx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
#brlzx-root .brlzx-kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;margin:10px 0}
#brlzx-root .brlzx-kv dt{color:var(--muted)}
#brlzx-root .brlzx-kv dd{margin:0;word-break:break-word}
#brlzx-root .brlzx-alert{border:1px solid var(--line);border-left:4px solid #c98a00;border-radius:8px;padding:12px 14px;margin-bottom:18px;background:#fff;font-size:13px}
#brlzx-root .brlzx-alert.error{border-left-color:#c0392b}
#brlzx-root .brlzx-alert.ok{border-left-color:#1e8e5a}
#brlzx-root details{margin-top:10px;font-size:13px}
#brlzx-root details summary{cursor:pointer;color:var(--muted)}
#brlzx-root details form{margin-top:10px}
#brlzx-root .brlzx-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#brlzx-root select,#brlzx-root input,#brlzx-root textarea{width:100%}
#brlzx-root table td,#brlzx-root table th{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
@media(max-width:760px){#brlzx-root .brlzx-kv{grid-template-columns:1fr}#brlzx-root .brlzx-kv dt{margin-top:6px}}`;
  document.head.appendChild(el);
}

export function brlzxBody(route) {
  const view = route === '/app/brlzx/backoffice' ? 'backoffice' : 'cliente';
  return `<div id="brlzx-root" data-view="${view}">
    <div class="app-heading"><div><span class="eyebrow">Stablecoin em reais</span><h1>BRLZX${view === 'backoffice' ? ' · Backoffice' : ''}</h1></div></div>
    <div id="brlzx-msg" aria-live="polite"></div>
    <div id="brlzx-content">${loading()}</div>
  </div>`;
}

// ───────────── Montagem ─────────────
export function mountBrlzx(app, { toast, isAdmin = false } = {}) {
  const root = app.querySelector('#brlzx-root');
  if (!root) return () => {};
  injectStyle();
  const view = root.dataset.view;
  const content = root.querySelector('#brlzx-content');
  const msgBox = root.querySelector('#brlzx-msg');
  const controller = new AbortController(); const { signal } = controller;
  let alive = true; let ticker = 0;
  const me = currentUser();
  const st = { settings: null, org: null, tab: 'ordens', filter: 'abertas', orders: [], people: {}, chain: null, foundClient: null };

  const say = (text, kind = '') => { if (alive) msgBox.innerHTML = text ? `<div class="brlzx-alert ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${text}</div>` : ''; };
  const fail = (err) => { say(esc(err?.message || 'Algo deu errado.'), 'error'); toast && toast('Erro: ' + (err?.message || '')); };
  const done = (text) => { say(esc(text), 'ok'); toast && toast(text); };

  // Estado do contrato na rede (ou null se não configurado / rede fora).
  async function loadChain() {
    if (!chainOf(st.settings)) { st.chain = null; return; }
    try {
      const { contract: c } = await reader(st.settings);
      const [supply, reserve, deadline, threshold, paused, reserveAt] = await Promise.all([
        c.totalSupply(), c.attestedReserve(), c.coverageDeadline(), c.dualApprovalThreshold(), c.paused(), c.reserveUpdatedAt(),
      ]);
      st.chain = { supply, reserve, deadline: Number(deadline), threshold, paused, reserveAt: Number(reserveAt) };
    } catch (e) { st.chain = { error: e?.shortMessage || e?.message || 'Rede indisponível.' }; }
  }

  async function balances(addresses) {
    const out = {};
    if (!chainOf(st.settings) || !addresses.length) return out;
    try {
      const { contract: c } = await reader(st.settings);
      const vals = await Promise.all(addresses.map((a) => c.balanceOf(a)));
      addresses.forEach((a, i) => { out[a] = vals[i]; });
    } catch { /* sem saldo se a rede estiver fora */ }
    return out;
  }

  const notConfigured = () => `<div class="brlzx-alert">O contrato do BRLZX ainda não foi publicado na rede. Cadastros já funcionam; emissões e resgates ficam disponíveis depois da publicação.</div>`;
  const identity = () => `<p class="small">Emissora: TokenHub. Titular do token e da reserva: ${esc(st.settings?.owner_name || 'a definir')}.</p>`;

  // =====================================================================
  // ÁREA DO CLIENTE
  // =====================================================================
  async function renderClient() {
    const [wallets, orders] = await Promise.all([
      rest(`brlzx_wallets?select=*&user_id=eq.${me.id}&order=created_at.asc`),
      rest(`brlzx_orders?select=*&user_id=eq.${me.id}&order=created_at.desc`),
    ]);
    if (!alive) return;
    st.orders = orders;
    const active = wallets.filter((w) => w.active);
    const bal = await balances(active.map((w) => w.address));
    if (!alive) return;
    const total = Object.values(bal).reduce((a, b) => a + b, 0n);
    const live = !!chainOf(st.settings);
    const s = st.settings || {};
    const walletOptions = active.map((w) => `<option value="${esc(w.address)}">${esc(w.label || 'Carteira')} · ${esc(shortHex(w.address))}</option>`).join('');
    const dep = [['Titular', s.deposit_holder || s.owner_name], ['CPF/CNPJ', s.deposit_document], ['Chave Pix', s.deposit_pix_key], ['Banco', s.deposit_bank], ['Agência', s.deposit_agency], ['Conta', s.deposit_account], ['Observações', s.deposit_notes]].filter(([, v]) => v);

    const orderRow = (o) => {
      const emissao = o.kind === 'emissao';
      const txs = [txLink(s, o.mint_tx, 'Emissão'), txLink(s, o.deposit_tx || o.client_tx, 'Envio'), txLink(s, o.burn_tx, 'Queima')].filter(Boolean).join(' · ');
      const send = !emissao && o.status === 'solicitada' ? `
        <div class="brlzx-alert" style="margin-top:10px">Envie <strong>${esc(unitsBRL(centsToUnits(o.amount_cents)))}</strong> da carteira ${esc(shortHex(o.wallet_address))} para a tesouraria:
          <div class="brlzx-mono">${esc(s.treasury_address || 'endereço da tesouraria ainda não configurado')}</div>
          <div class="brlzx-actions" style="margin-top:8px">
            ${s.treasury_address && live ? `<button class="btn btn-primary btn-sm" data-act="send-tokens" data-id="${o.id}">Enviar pela carteira do navegador</button>` : ''}
          </div>
          <details><summary>Já enviei: informar o hash da transação</summary>
            <form data-form="inform-tx" data-id="${o.id}"><div class="field"><input name="tx" placeholder="0x…" value="${esc(o.client_tx || '')}" required></div><button class="btn btn-outline btn-sm">Informar envio</button></form></details>
          ${o.client_tx ? '<p class="small">Envio informado. A emissora confere e segue com o pagamento.</p>' : ''}
        </div>` : '';
      return `<article class="panel" style="padding:20px">
        <div class="row between wrap" style="gap:10px">
          <div><span class="eyebrow">${emissao ? 'Emissão · ' + esc(PAYMENT_METHODS[o.payment_method] || '') : 'Resgate'}</span>
            <h3 style="margin:4px 0">${esc(fmtBRL(o.amount_cents))}</h3>
            <p class="small">${dt(o.created_at)} · carteira ${esc(shortHex(o.wallet_address))} · ${badge(o.status)}</p>
            ${o.reject_reason ? `<p class="small">Motivo: ${esc(o.reject_reason)}</p>` : ''}
            ${txs ? `<p class="small">${txs}</p>` : ''}</div>
          <div>${o.status === 'solicitada' ? `<button class="btn btn-outline btn-sm" data-act="cancel-order" data-id="${o.id}">Cancelar</button>` : ''}</div>
        </div>${send}</article>`;
    };

    content.innerHTML = `
      ${identity()}
      ${st.org || isAdmin ? `<p><a class="btn btn-outline btn-sm" href="#/app/brlzx/backoffice">Abrir backoffice</a></p>` : ''}
      ${live ? '' : notConfigured()}
      <div class="stats">
        <div class="stat"><span class="stat-label">Saldo nas suas carteiras</span><span class="stat-value" style="color:var(--navy)">${live ? esc(unitsBRL(total)) : '—'}</span></div>
        <div class="stat"><span class="stat-label">Ordens em andamento</span><span class="stat-value" style="color:var(--navy)">${orders.filter(isOpen).length}</span></div>
        <div class="stat"><span class="stat-label">Rede</span><span class="stat-value" style="color:var(--navy);font-size:20px">${esc(NETWORKS[s.chain_id]?.name || '—')}</span></div>
      </div>

      <section class="panel"><h2>Suas carteiras</h2>
        <p class="small">Endereços na rede ${esc(NETWORKS[s.chain_id]?.name || 'Polygon')} para receber e enviar BRLZX. Confira com atenção: envio para endereço errado não tem volta.</p>
        ${wallets.length ? `<div class="table-wrap" style="margin:12px 0"><table><tbody>${wallets.map((w) => `<tr><td>${esc(w.label || 'Carteira')}</td><td class="brlzx-mono">${esc(w.address)}</td><td>${w.active ? (live ? esc(unitsBRL(bal[w.address] ?? 0n)) : '—') : '<span class="badge badge-red">Desativada</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small">Nenhuma carteira cadastrada ainda.</p>'}
        <form data-form="add-wallet" class="form-grid" autocomplete="off">
          <div class="field"><label>Endereço</label><input name="address" placeholder="0x…" required></div>
          <div class="field"><label>Apelido (opcional)</label><input name="label" placeholder="Ex.: MetaMask pessoal"></div>
          <div class="brlzx-actions" style="grid-column:1/-1"><button class="btn btn-dark">Cadastrar carteira</button>
            <button type="button" class="btn btn-outline" data-act="use-browser-wallet">Usar a carteira deste navegador</button></div>
        </form>
      </section>

      <section class="panel"><h2>Pedir emissão</h2>
        <p class="small">Você paga em reais e recebe BRLZX na carteira escolhida, na proporção de 1 para 1.</p>
        <form data-form="issue" class="form-grid" autocomplete="off">
          <div class="field"><label>Valor em reais</label><input name="amount" inputmode="decimal" placeholder="Ex.: 1.000,00" required></div>
          <div class="field"><label>Forma de pagamento</label><select name="method">${Object.entries(PAYMENT_METHODS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div class="field" style="grid-column:1/-1"><label>Carteira de destino</label><select name="wallet" required>${walletOptions || '<option value="">Cadastre uma carteira primeiro</option>'}</select></div>
          <div style="grid-column:1/-1"><button class="btn btn-dark" ${live && active.length ? '' : 'disabled'}>Pedir emissão</button></div>
        </form>
        <h3 style="margin-top:18px">Dados para pagamento</h3>
        ${dep.length ? `<dl class="brlzx-kv">${dep.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><p class="small">Pague somente para estes dados. A conta é da titular do token, não da TokenHub.</p>` : '<p class="small">Os dados de pagamento ainda não foram informados pela titular do token.</p>'}
      </section>

      <section class="panel"><h2>Pedir resgate</h2>
        <p class="small">Você envia BRLZX para a tesouraria e recebe o valor em reais na conta informada.</p>
        <form data-form="redeem" class="form-grid" autocomplete="off">
          <div class="field"><label>Valor em BRLZX</label><input name="amount" inputmode="decimal" placeholder="Ex.: 1.000,00" required></div>
          <div class="field"><label>Carteira de origem</label><select name="wallet" required>${walletOptions || '<option value="">Cadastre uma carteira primeiro</option>'}</select></div>
          <div class="field" style="grid-column:1/-1"><label>Chave Pix ou dados bancários para receber</label><input name="payout" placeholder="Chave Pix, ou banco / agência / conta / titular" required></div>
          <div style="grid-column:1/-1"><button class="btn btn-dark" ${live && active.length ? '' : 'disabled'}>Pedir resgate</button></div>
        </form>
      </section>

      <section><h2>Suas ordens</h2>
        ${orders.length ? orders.map(orderRow).join('') : '<div class="empty"><h3>Nenhuma ordem</h3><p>Suas emissões e resgates aparecem aqui.</p></div>'}
      </section>`;
  }

  // =====================================================================
  // BACKOFFICE
  // =====================================================================
  const TABS = [['ordens', 'Ordens'], ['cobertura', 'Cobertura e reserva'], ['compliance', 'Compliance'], ['auditoria', 'Auditoria'], ['equipe', 'Equipe e configuração']];

  async function renderBackoffice() {
    if (!st.org && !isAdmin) {
      content.innerHTML = `<div class="panel"><h2>Acesso restrito</h2><p>Esta área é da equipe da emissora e da proprietária do BRLZX.</p><a class="btn btn-outline" href="#/app/brlzx">Voltar</a></div>`;
      return;
    }
    if (!st.org) st.tab = 'equipe';   // admin do TokenHub ainda fora da equipe: só monta a equipe e a rede
    const tabs = (st.org ? TABS : TABS.filter(([k]) => k === 'equipe'))
      .map(([k, label]) => `<button class="tab" role="tab" aria-selected="${st.tab === k}" data-act="tab" data-tab="${k}">${label}</button>`).join('');
    const head = `<p class="small">Você atua por: <strong>${esc(ORG_LABEL[st.org] || 'administrador do TokenHub (fora da equipe do BRLZX)')}</strong>.</p>
      ${chainOf(st.settings) ? '' : notConfigured()}
      ${st.chain?.error ? `<div class="brlzx-alert error">Não foi possível ler o contrato na rede: ${esc(st.chain.error)}</div>` : ''}
      ${st.chain?.paused ? '<div class="brlzx-alert error">O contrato está <strong>pausado</strong>: transferências, emissões e resgates estão travados.</div>' : ''}
      <div class="tabs" role="tablist">${tabs}</div><div id="brlzx-tab">${loading()}</div>`;
    content.innerHTML = head;
    const box = content.querySelector('#brlzx-tab');
    const html = await ({ ordens: tabOrders, cobertura: tabCoverage, compliance: tabCompliance, auditoria: tabAudit, equipe: tabTeam })[st.tab]();
    if (alive) box.innerHTML = html;
  }

  async function loadPeople(ids) {
    const missing = [...new Set(ids)].filter((id) => id && !st.people[id]);
    if (!missing.length) return;
    try { (await rpc('brlzx_people', { p_ids: missing })).forEach((p) => { st.people[p.id] = p; }); } catch { /* admin fora da equipe não consulta cadastros */ }
  }
  const person = (id) => { const p = st.people[id]; return p ? esc(p.full_name ? `${p.full_name} (${p.email})` : p.email) : esc(shortHex(id || '—', 8, 4)); };

  // ---------- Ordens ----------
  async function tabOrders() {
    st.orders = await rest('brlzx_orders?select=*&order=created_at.desc&limit=300');
    await loadPeople(st.orders.map((o) => o.user_id));
    const s = st.settings;
    const list = st.orders.filter((o) => (st.filter === 'abertas' ? isOpen(o) : true));
    const mine = st.orders.filter((o) => nextAction(o, st.org)).length;

    const card = (o) => {
      const emissao = o.kind === 'emissao';
      const act = nextAction(o, st.org);
      const wait = waitingOn(o);
      const txs = [txLink(s, o.proposal_tx, 'Proposta'), txLink(s, o.mint_tx, 'Emissão'), txLink(s, o.client_tx && !o.deposit_tx ? o.client_tx : null, 'Envio informado pelo cliente'), txLink(s, o.deposit_tx, 'Envio confirmado'), txLink(s, o.burn_tx, 'Queima')].filter(Boolean).join(' · ');
      let manual = '';
      if (act?.key === 'emitir') manual = `<details><summary>Já executei na rede: informar hash</summary><form data-form="manual-tx" data-id="${o.id}" data-key="emitir" class="form-grid">
        <div class="field"><label>O que foi feito</label><select name="how"><option value="mint">Emissão direta (mint)</option><option value="propose">Proposta para 2ª aprovação (proposeMint)</option></select></div>
        <div class="field"><label>Hash da transação</label><input name="tx" placeholder="0x…" required></div><div><button class="btn btn-outline btn-sm">Registrar</button></div></form></details>`;
      else if (act?.key === 'aprovar' || act?.key === 'queimar') manual = `<details><summary>Já executei na rede: informar hash</summary><form data-form="manual-tx" data-id="${o.id}" data-key="${act.key}">
        <div class="field"><input name="tx" placeholder="0x…" required></div><button class="btn btn-outline btn-sm">Registrar</button></form></details>`;
      const receive = act?.key === 'receber' ? `<form data-form="receive" data-id="${o.id}" style="margin-top:10px">
        <div class="field"><label>Hash do envio dos tokens à tesouraria ${o.client_tx ? '(informado pelo cliente)' : ''}</label><input name="tx" placeholder="0x…" value="${esc(o.client_tx || '')}" required></div>
        <button class="btn btn-primary btn-sm">Conferir na rede e confirmar recebimento</button></form>` : '';
      return `<article class="panel" style="padding:20px">
        <div class="row between wrap" style="gap:12px">
          <div style="min-width:0"><span class="eyebrow">${emissao ? 'Emissão · ' + esc(PAYMENT_METHODS[o.payment_method] || '') : 'Resgate'}</span>
            <h3 style="margin:4px 0">${esc(fmtBRL(o.amount_cents))}</h3>
            <p class="small">${person(o.user_id)} · ${dt(o.created_at)} · ${badge(o.status)}</p>
            <dl class="brlzx-kv">
              <dt>Carteira do cliente</dt><dd class="brlzx-mono">${esc(o.wallet_address)}</dd>
              <dt>Referência</dt><dd class="brlzx-mono">${esc(o.ref)}</dd>
              ${o.payout_details ? `<dt>Pagar em</dt><dd>${esc(o.payout_details)}</dd>` : ''}
              ${o.note ? `<dt>Observação</dt><dd>${esc(o.note)}</dd>` : ''}
              ${o.reject_reason ? `<dt>Motivo da rejeição</dt><dd>${esc(o.reject_reason)}</dd>` : ''}
              ${txs ? `<dt>Na rede</dt><dd>${txs}</dd>` : ''}
            </dl>
            ${!act && wait ? `<p class="small">Aguardando: ${esc(ORG_LABEL[wait])}.</p>` : ''}</div>
          <div class="brlzx-actions">
            ${act && act.key !== 'receber' ? `<button class="btn btn-primary btn-sm" data-act="order-act" data-key="${act.key}" data-id="${o.id}">${esc(act.label)}</button>` : ''}
            ${canReject(o, st.org) ? `<button class="btn btn-outline btn-sm" data-act="order-reject" data-id="${o.id}">Rejeitar</button>` : ''}
          </div>
        </div>${receive}${manual}</article>`;
    };

    const found = st.foundClient;
    const onBehalf = st.org === 'emissora' ? `<section class="panel"><h2>Abrir ordem em nome de cliente</h2>
      <p class="small">Para pagamento presencial (dinheiro, boleto) ou atendimento assistido.</p>
      <form data-form="find-client" class="form-grid" autocomplete="off">
        <div class="field"><label>E-mail da conta do cliente</label><input name="email" type="email" value="${esc(found?.email || '')}" required></div>
        <div style="align-self:end"><button class="btn btn-outline">Localizar</button></div>
      </form>
      ${found ? `<p class="small" style="margin-top:10px">Cliente: <strong>${esc(found.full_name || found.email)}</strong></p>
        <form data-form="staff-wallet" class="form-grid" autocomplete="off">
          <div class="field"><label>Cadastrar carteira do cliente</label><input name="address" placeholder="0x…" required></div>
          <div style="align-self:end"><button class="btn btn-outline">Cadastrar</button></div></form>
        <form data-form="staff-issue" class="form-grid" autocomplete="off" style="margin-top:14px">
          <div class="field"><label>Valor em reais</label><input name="amount" inputmode="decimal" required></div>
          <div class="field"><label>Forma de pagamento</label><select name="method">${Object.entries(PAYMENT_METHODS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
          <div class="field"><label>Carteira de destino</label><select name="wallet" required>${found.wallets.map((w) => `<option value="${esc(w.address)}">${esc(shortHex(w.address))}</option>`).join('') || '<option value="">Cadastre uma carteira</option>'}</select></div>
          <div class="field"><label>Observação</label><input name="note" placeholder="Ex.: recibo nº 123"></div>
          <div style="grid-column:1/-1"><button class="btn btn-dark" ${found.wallets.length ? '' : 'disabled'}>Abrir ordem de emissão</button></div></form>` : ''}
    </section>` : '';

    return `<div class="row between wrap" style="gap:10px;margin-bottom:14px">
        <p class="small" style="margin:0">${mine ? `<strong>${mine}</strong> ordem(ns) esperando por você.` : 'Nenhuma ordem esperando por você.'}</p>
        <div class="brlzx-actions"><button class="btn btn-sm ${st.filter === 'abertas' ? 'btn-dark' : 'btn-outline'}" data-act="filter" data-filter="abertas">Em andamento</button>
          <button class="btn btn-sm ${st.filter === 'todas' ? 'btn-dark' : 'btn-outline'}" data-act="filter" data-filter="todas">Todas</button></div></div>
      ${list.length ? list.map(card).join('') : '<div class="empty"><h3>Nenhuma ordem</h3><p>As ordens de emissão e resgate aparecem aqui.</p></div>'}
      ${onBehalf}`;
  }

  // ---------- Cobertura e reserva ----------
  async function tabCoverage() {
    const [totals, atts] = await Promise.all([rpc('brlzx_totals'), rest('brlzx_reserve_attestations?select=*&order=created_at.desc&limit=50')]);
    await loadPeople(atts.map((a) => a.created_by));
    const t = totals?.[0] || {};
    const c = st.chain && !st.chain.error ? st.chain : null;
    let chainHtml = '<p class="small">Sem leitura da rede: os números abaixo são só os do backoffice.</p>';
    if (c) {
      const cov = coverageState({ supply: c.supply, reserve: c.reserve, deadline: c.deadline, now: Math.floor(Date.now() / 1000) });
      const prazo = cov.status === 'coberto' ? '<span class="badge badge-green">Tudo coberto</span>'
        : cov.status === 'no_prazo' ? `<span class="badge badge-amber">Faltam <span id="brlzx-countdown" data-deadline="${c.deadline}">${fmtCountdown(cov.remaining)}</span></span>`
        : '<span class="badge badge-red">Prazo vencido · emissões travadas</span>';
      const margin = c.threshold > cov.uncovered ? c.threshold - cov.uncovered : 0n;
      const diff = unitsToCents(c.supply) - Number(t.em_circulacao_cents || 0);
      chainHtml = `<div class="stats">
          <div class="stat"><span class="stat-label">Em circulação (rede)</span><span class="stat-value" style="color:var(--navy)">${esc(unitsBRL(c.supply))}</span></div>
          <div class="stat"><span class="stat-label">Reserva atestada (rede)</span><span class="stat-value" style="color:var(--navy)">${esc(fmtBRL(unitsToCents(c.reserve)))}</span><span class="stat-foot small">${c.reserveAt ? 'em ' + dt(new Date(c.reserveAt * 1000).toISOString()) : 'nunca atestada'}</span></div>
          <div class="stat"><span class="stat-label">Descoberto</span><span class="stat-value" style="color:var(--navy)">${esc(fmtBRL(unitsToCents(cov.uncovered)))}</span><span class="stat-foot">${prazo}</span></div>
        </div>
        <dl class="brlzx-kv">
          <dt>Limite sem 2ª aprovação</dt><dd>${esc(fmtBRL(unitsToCents(c.threshold)))} de total descoberto</dd>
          <dt>Margem para emissão direta agora</dt><dd>${esc(fmtBRL(unitsToCents(margin)))} além do que a reserva cobre</dd>
          <dt>Situação do contrato</dt><dd>${c.paused ? 'Pausado' : 'Ativo'}</dd>
        </dl>
        ${diff !== 0 ? `<div class="brlzx-alert error">Divergência: a rede mostra ${esc(fmtBRL(unitsToCents(c.supply)))} em circulação e o backoffice ${esc(fmtBRL(t.em_circulacao_cents))}. Há emissão ou queima feita na rede e não registrada aqui (ou o inverso).</div>` : '<p class="small">Rede e backoffice conferem.</p>'}`;
    }
    const attest = st.org === 'proprietaria' ? `<section class="panel"><h2>Atestar reserva</h2>
        <p class="small">Informe o total do lastro hoje. O valor é gravado no contrato e substitui a atestação anterior. Se cobrir todo o valor em circulação, o prazo de 48h zera.</p>
        <form data-form="attest" class="form-grid" autocomplete="off">
          <div class="field"><label>Saldo em conta (R$)</label><input name="cash" inputmode="decimal" placeholder="0,00" required></div>
          <div class="field"><label>Títulos públicos (R$)</label><input name="bonds" inputmode="decimal" placeholder="0,00" required></div>
          <div class="field" style="grid-column:1/-1"><label>Observação</label><input name="note" placeholder="Ex.: extrato de 20/11 + Tesouro Selic 2029"></div>
          <div style="grid-column:1/-1"><button class="btn btn-dark">Atestar na rede</button></div>
        </form>
        <details><summary>Já atestei na rede: informar hash</summary><form data-form="attest" data-manual="1" class="form-grid">
          <div class="field"><label>Saldo em conta (R$)</label><input name="cash" required></div><div class="field"><label>Títulos públicos (R$)</label><input name="bonds" required></div>
          <div class="field"><label>Hash</label><input name="tx" placeholder="0x…" required></div><div class="field"><label>Observação</label><input name="note"></div>
          <div><button class="btn btn-outline btn-sm">Registrar</button></div></form></details>
      </section>` : '<p class="small">A atestação da reserva é feita pela proprietária.</p>';
    const pause = c ? `<section class="panel"><h2>Emergência</h2>
        <p class="small">Pausar trava transferências, emissões e resgates de todos. Qualquer das duas empresas pausa; só a proprietária retoma.</p>
        <div class="brlzx-actions">${c.paused ? (st.org === 'proprietaria' ? '<button class="btn btn-dark" data-act="unpause">Retomar o contrato</button>' : '<span class="small">Só a proprietária retoma.</span>') : '<button class="btn btn-outline" data-act="pause">Pausar o contrato</button>'}</div></section>` : '';
    return `${chainHtml}
      <dl class="brlzx-kv"><dt>Emitido (backoffice)</dt><dd>${esc(fmtBRL(t.emitido_cents))}</dd><dt>Queimado (backoffice)</dt><dd>${esc(fmtBRL(t.queimado_cents))}</dd>
        <dt>Pendências</dt><dd>${Number(t.emissoes_pendentes || 0)} emissão(ões) a executar · ${Number(t.propostas_pendentes || 0)} aguardando 2ª aprovação · ${Number(t.resgates_a_pagar || 0)} resgate(s) a pagar · ${Number(t.resgates_a_queimar || 0)} a queimar</dd></dl>
      ${attest}${pause}
      <section><h2>Atestações</h2>${atts.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Conta</th><th>Títulos</th><th>Total</th><th>Por</th><th>Rede</th></tr></thead><tbody>${atts.map((a) => `<tr><td>${dt(a.created_at)}</td><td>${esc(fmtBRL(a.cash_cents))}</td><td>${esc(fmtBRL(a.bonds_cents))}</td><td><strong>${esc(fmtBRL(a.total_cents))}</strong></td><td>${person(a.created_by)}${a.note ? '<br><span class="small">' + esc(a.note) + '</span>' : ''}</td><td>${txLink(st.settings, a.tx, '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small">Nenhuma atestação registrada.</p>'}</section>`;
  }

  // ---------- Compliance ----------
  async function tabCompliance() {
    const rows = await rest('brlzx_compliance_actions?select=*&order=created_at.desc&limit=100');
    await loadPeople(rows.map((r) => r.created_by));
    const form = st.org === 'emissora' ? `<section class="panel"><h2>Bloquear ou desbloquear endereço</h2>
        <p class="small">Endereço bloqueado não envia nem recebe BRLZX. Destruir o saldo só é possível em endereço já bloqueado e não tem volta.</p>
        <form data-form="compliance" class="form-grid" autocomplete="off">
          <div class="field" style="grid-column:1/-1"><label>Endereço</label><input name="address" placeholder="0x…" required></div>
          <div class="field"><label>Ação</label><select name="action"><option value="bloquear">Bloquear</option><option value="desbloquear">Desbloquear</option><option value="destruir">Destruir saldo bloqueado</option></select></div>
          <div class="field"><label>Motivo</label><input name="reason" placeholder="Ex.: ofício nº …" required></div>
          <div class="brlzx-actions" style="grid-column:1/-1"><button class="btn btn-dark">Executar na rede</button><button type="button" class="btn btn-outline" data-act="check-address">Consultar situação</button></div>
        </form><div id="brlzx-check" class="small" style="margin-top:10px"></div></section>` : '<p class="small">Bloqueios são feitos pela emissora. A proprietária acompanha o histórico.</p>';
    const label = { bloquear: 'Bloqueio', desbloquear: 'Desbloqueio', destruir: 'Destruição de saldo' };
    return `${form}<section><h2>Histórico</h2>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Ação</th><th>Endereço</th><th>Motivo</th><th>Por</th><th>Rede</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${dt(r.created_at)}</td><td>${esc(label[r.action] || r.action)}</td><td class="brlzx-mono">${esc(r.address)}</td><td>${esc(r.reason)}</td><td>${person(r.created_by)}</td><td>${txLink(st.settings, r.tx, '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small">Nenhuma ação registrada.</p>'}</section>`;
  }

  // ---------- Auditoria ----------
  async function tabAudit() {
    const rows = await rest('brlzx_audit?select=*&order=id.desc&limit=200');
    await loadPeople(rows.map((r) => r.actor));
    if (!rows.length) return '<p class="small">Nenhum registro.</p>';
    return `<p class="small">Últimos ${rows.length} atos. A trilha não pode ser alterada nem apagada.</p>
      <div class="table-wrap"><table><thead><tr><th>Quando</th><th>Quem</th><th>Empresa</th><th>Ato</th><th>Sobre</th><th>Detalhes</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${dt(r.at)}</td><td>${person(r.actor)}</td><td>${esc(r.actor_org === 'emissora' ? 'TokenHub' : r.actor_org === 'proprietaria' ? 'Proprietária' : 'Cliente')}</td><td>${esc(r.action)}</td><td class="brlzx-mono">${esc(r.entity)} ${esc(shortHex(r.entity_id || '', 8, 4))}</td><td class="brlzx-mono">${esc(JSON.stringify(r.data))}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------- Equipe e configuração ----------
  async function tabTeam() {
    const members = await rest('brlzx_members?select=*&order=org.asc,created_at.asc');
    await loadPeople(members.map((m) => m.user_id));
    const s = st.settings || {};
    const hasOwner = members.some((m) => m.org === 'proprietaria' && m.active);
    const orgs = [];
    if (isAdmin) orgs.push('emissora');
    if (st.org === 'proprietaria' || (isAdmin && !hasOwner)) orgs.push('proprietaria');
    const canNetwork = st.org === 'proprietaria' || isAdmin;
    const f = (label, name, value, hint = '') => `<div class="field"><label>${label}</label><input name="${name}" value="${esc(value || '')}" placeholder="${esc(hint)}"></div>`;
    return `<section class="panel"><h2>Equipe</h2>
        <p class="small">A equipe da emissora é definida pelo administrador do TokenHub. A da proprietária, por ela mesma: o administrador do TokenHub só inclui a primeira pessoa. Ninguém atua pelas duas empresas.</p>
        ${members.length ? `<div class="table-wrap" style="margin:12px 0"><table><thead><tr><th>Pessoa</th><th>Empresa</th><th>Situação</th><th></th></tr></thead><tbody>${members.map((m) => `<tr><td>${person(m.user_id)}</td><td>${esc(ORG_LABEL[m.org])}</td><td>${m.active ? '<span class="badge badge-green">Ativa</span>' : '<span class="badge badge-red">Inativa</span>'}</td><td>${orgs.includes(m.org) || (m.org === 'proprietaria' && st.org === 'proprietaria') ? `<button class="btn btn-outline btn-sm" data-act="member-toggle" data-id="${m.user_id}" data-org="${m.org}" data-active="${m.active ? '0' : '1'}">${m.active ? 'Desativar' : 'Reativar'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small">Ninguém na equipe ainda.</p>'}
        ${orgs.length ? `<form data-form="member" class="form-grid" autocomplete="off">
          <div class="field"><label>E-mail da conta (a pessoa precisa já ter cadastro)</label><input name="email" type="email" required></div>
          <div class="field"><label>Empresa</label><select name="org">${orgs.map((o) => `<option value="${o}">${esc(ORG_LABEL[o])}</option>`).join('')}</select></div>
          <div style="grid-column:1/-1"><button class="btn btn-dark">Incluir na equipe</button></div></form>` : ''}
      </section>
      <section class="panel"><h2>Rede e contrato</h2>
        ${canNetwork ? `<form data-form="network" class="form-grid" autocomplete="off">
          <div class="field"><label>Rede</label><select name="chain">${Object.entries(NETWORKS).map(([id, n]) => `<option value="${id}" ${Number(id) === s.chain_id ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select></div>
          ${f('Endereço do contrato BRLZX (proxy)', 'contract', s.contract_address, '0x…')}
          ${f('Endereço da tesouraria (recebe os resgates)', 'treasury', s.treasury_address, '0x…')}
          <div style="grid-column:1/-1"><button class="btn btn-dark">Salvar</button></div></form>`
      : `<dl class="brlzx-kv"><dt>Rede</dt><dd>${esc(NETWORKS[s.chain_id]?.name || '—')}</dd><dt>Contrato</dt><dd class="brlzx-mono">${esc(s.contract_address || '—')}</dd><dt>Tesouraria</dt><dd class="brlzx-mono">${esc(s.treasury_address || '—')}</dd></dl>`}
      </section>
      <section class="panel"><h2>Dados de depósito</h2>
        <p class="small">Conta da proprietária para onde o cliente paga as emissões. Só a proprietária altera.</p>
        ${st.org === 'proprietaria' ? `<form data-form="deposit" class="form-grid" autocomplete="off">
          ${f('Razão social da proprietária', 'owner_name', s.owner_name)}${f('Titular da conta', 'deposit_holder', s.deposit_holder)}
          ${f('CPF/CNPJ do titular', 'deposit_document', s.deposit_document)}${f('Chave Pix', 'deposit_pix_key', s.deposit_pix_key)}
          ${f('Banco', 'deposit_bank', s.deposit_bank)}${f('Agência', 'deposit_agency', s.deposit_agency)}
          ${f('Conta', 'deposit_account', s.deposit_account)}${f('Observações', 'deposit_notes', s.deposit_notes)}
          <div style="grid-column:1/-1"><button class="btn btn-dark">Salvar dados de depósito</button></div></form>`
      : `<dl class="brlzx-kv"><dt>Proprietária</dt><dd>${esc(s.owner_name || '—')}</dd><dt>Titular</dt><dd>${esc(s.deposit_holder || '—')}</dd><dt>Chave Pix</dt><dd>${esc(s.deposit_pix_key || '—')}</dd><dt>Banco</dt><dd>${esc([s.deposit_bank, s.deposit_agency, s.deposit_account].filter(Boolean).join(' · ') || '—')}</dd></dl>`}
      </section>`;
  }

  // =====================================================================
  // AÇÕES
  // =====================================================================
  const orderById = (id) => st.orders.find((o) => o.id === id);
  const needTx = (v) => { const t = String(v || '').trim().toLowerCase(); if (!isTx(t)) throw new Error('Hash de transação inválido (0x seguido de 64 caracteres).'); return t; };
  const needCents = (v, what = 'Valor') => { const c = parseBRL(v); if (!c) throw new Error(`${what} inválido. Use o formato 1.000,00.`); return c; };
  const zeroOrCents = (v) => (/^\s*0([.,]0{1,2})?\s*$/.test(String(v)) ? 0 : needCents(v));

  // Executa na rede e registra no backoffice. Se o registro falhar, mostra o hash para registrar à mão.
  async function chainThenRecord(build, record, okText) {
    say('Assine a transação na carteira e aguarde a confirmação da rede…');
    const hash = await sendTx(st.settings, build);
    try { await record(hash); }
    catch (e) { throw new Error(`A transação foi confirmada na rede (${hash}), mas o registro no backoffice falhou: ${e.message}. Use "Já executei na rede: informar hash" com este hash.`); }
    done(okText);
  }

  async function orderAct(o, key) {
    const units = centsToUnits(o.amount_cents);
    if (key === 'emitir') {
      const { contract: c } = await reader(st.settings);
      const [supply, reserve, threshold] = await Promise.all([c.totalSupply(), c.attestedReserve(), c.dualApprovalThreshold()]);
      const { path, uncoveredAfter } = mintPath({ supply, reserve, amount: units, threshold });
      if (path === 'mint') {
        if (!confirm(`Emitir ${fmtBRL(o.amount_cents)} em BRLZX para ${o.wallet_address}?\n\nTotal descoberto depois desta emissão: ${fmtBRL(unitsToCents(uncoveredAfter))}.`)) return;
        await chainThenRecord((k) => k.mint(o.wallet_address, units, o.ref), (tx) => rpc('brlzx_issue_minted', { p_order_id: o.id, p_tx: tx }), 'Emissão concluída.');
      } else {
        if (!confirm(`Esta emissão deixaria ${fmtBRL(unitsToCents(uncoveredAfter))} descobertos, acima do limite de ${fmtBRL(unitsToCents(threshold))}.\n\nEla será PROPOSTA e só sai depois da aprovação da proprietária. Continuar?`)) return;
        await chainThenRecord((k) => k.proposeMint(o.wallet_address, units, o.ref), (tx) => rpc('brlzx_issue_proposed', { p_order_id: o.id, p_tx: tx }), 'Emissão proposta. Aguardando a aprovação da proprietária.');
      }
    } else if (key === 'aprovar') {
      if (!confirm(`Aprovar a emissão de ${fmtBRL(o.amount_cents)} em BRLZX para ${o.wallet_address}?\n\nA aprovação executa a emissão na rede.`)) return;
      await chainThenRecord((k) => k.approveMint(o.ref), (tx) => rpc('brlzx_issue_approved', { p_order_id: o.id, p_tx: tx }), 'Emissão aprovada e executada.');
    } else if (key === 'pagar') {
      if (!confirm(`Confirmar que ${fmtBRL(o.amount_cents)} foram pagos ao cliente?\n\nDestino: ${o.payout_details}`)) return;
      const note = prompt('Observação do pagamento (opcional), ex.: identificador do Pix:') || null;
      await rpc('brlzx_redeem_paid', { p_order_id: o.id, p_note: note });
      done('Pagamento confirmado. A emissora já pode queimar os tokens.');
    } else if (key === 'queimar') {
      if (!confirm(`Queimar ${fmtBRL(o.amount_cents)} em BRLZX da tesouraria? Não tem volta.`)) return;
      await chainThenRecord((k) => k.redeem(units, o.ref), (tx) => rpc('brlzx_redeem_burned', { p_order_id: o.id, p_tx: tx }), 'Tokens queimados. Resgate concluído.');
    }
  }

  const clickActions = {
    tab: async (b) => { st.tab = b.dataset.tab; say(''); },
    filter: async (b) => { st.filter = b.dataset.filter; },
    'order-act': async (b) => { const o = orderById(b.dataset.id); if (o) await orderAct(o, b.dataset.key); },
    'order-reject': async (b) => {
      const reason = prompt('Motivo da rejeição (o cliente vê este texto):');
      if (!reason || !reason.trim()) return;
      await rpc('brlzx_reject_order', { p_order_id: b.dataset.id, p_reason: reason });
      done('Ordem rejeitada.');
    },
    'cancel-order': async (b) => {
      if (!confirm('Cancelar esta ordem?')) return;
      await rpc('brlzx_cancel_order', { p_order_id: b.dataset.id });
      done('Ordem cancelada.');
    },
    'send-tokens': async (b) => {
      const o = orderById(b.dataset.id); if (!o) return;
      if (!confirm(`Enviar ${unitsBRL(centsToUnits(o.amount_cents))} para a tesouraria?\n\n${st.settings.treasury_address}`)) return;
      say('Assine a transação na carteira e aguarde a confirmação da rede…');
      const hash = await sendTx(st.settings, (k, w) => {
        if (w.address !== o.wallet_address) throw new Error(`A carteira conectada (${shortHex(w.address)}) não é a carteira de origem desta ordem (${shortHex(o.wallet_address)}).`);
        return k.transfer(st.settings.treasury_address, centsToUnits(o.amount_cents));
      });
      await rpc('brlzx_redeem_inform_tx', { p_order_id: o.id, p_tx: hash });
      done('Tokens enviados. A emissora confere e segue com o pagamento.');
    },
    'use-browser-wallet': async () => {
      if (!window.ethereum) throw new Error('Nenhuma carteira encontrada neste navegador.');
      const [addr] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const input = root.querySelector('form[data-form="add-wallet"] input[name="address"]');
      if (input && addr) input.value = addr;
      return 'keep';
    },
    'check-address': async () => {
      const box = root.querySelector('#brlzx-check');
      const a = root.querySelector('form[data-form="compliance"] input[name="address"]').value.trim();
      if (!isAddress(a)) throw new Error('Endereço inválido.');
      const { contract: c } = await reader(st.settings);
      const [blocked, bal] = await Promise.all([c.isBlocked(a), c.balanceOf(a)]);
      box.innerHTML = `Situação na rede: <strong>${blocked ? 'bloqueado' : 'não bloqueado'}</strong> · saldo ${esc(unitsBRL(bal))}`;
      return 'keep';
    },
    'member-toggle': async (b) => {
      await rpc('brlzx_set_member', { p_user_id: b.dataset.id, p_org: b.dataset.org, p_active: b.dataset.active === '1' });
      done('Equipe atualizada.');
    },
    pause: async () => {
      if (!confirm('Pausar o contrato? Transferências, emissões e resgates de todos ficam travados até a proprietária retomar.')) return;
      say('Assine a transação na carteira…');
      await sendTx(st.settings, (k) => k.pause());
      done('Contrato pausado.');
    },
    unpause: async () => {
      if (!confirm('Retomar o contrato?')) return;
      say('Assine a transação na carteira…');
      await sendTx(st.settings, (k) => k.unpause());
      done('Contrato retomado.');
    },
  };

  const submitActions = {
    'add-wallet': async (fd) => {
      const a = String(fd.get('address')).trim();
      if (!isAddress(a)) throw new Error('Endereço de carteira inválido (0x seguido de 40 caracteres).');
      await rpc('brlzx_add_wallet', { p_address: a, p_label: fd.get('label') || null });
      done('Carteira cadastrada.');
    },
    issue: async (fd) => {
      const cents = needCents(fd.get('amount'));
      await rpc('brlzx_request_issue', { p_amount_cents: cents, p_payment_method: fd.get('method'), p_wallet_address: fd.get('wallet') });
      done('Pedido de emissão registrado. Faça o pagamento com os dados indicados.');
    },
    redeem: async (fd) => {
      const cents = needCents(fd.get('amount'));
      await rpc('brlzx_request_redeem', { p_amount_cents: cents, p_wallet_address: fd.get('wallet'), p_payout_details: fd.get('payout') });
      done('Pedido de resgate registrado. Envie os tokens para a tesouraria.');
    },
    'inform-tx': async (fd, form) => {
      await rpc('brlzx_redeem_inform_tx', { p_order_id: form.dataset.id, p_tx: needTx(fd.get('tx')) });
      done('Envio informado.');
    },
    'manual-tx': async (fd, form) => {
      const tx = needTx(fd.get('tx')); const id = form.dataset.id; const key = form.dataset.key;
      const fn = key === 'emitir' ? (fd.get('how') === 'propose' ? 'brlzx_issue_proposed' : 'brlzx_issue_minted')
        : key === 'aprovar' ? 'brlzx_issue_approved' : 'brlzx_redeem_burned';
      await rpc(fn, { p_order_id: id, p_tx: tx });
      done('Registro feito.');
    },
    receive: async (fd, form) => {
      const o = orderById(form.dataset.id); const tx = needTx(fd.get('tx'));
      let problem = null;
      try { problem = await verifyDeposit(st.settings, o, tx); }
      catch (e) { problem = 'Não foi possível conferir na rede: ' + (e?.shortMessage || e?.message || 'rede indisponível') + '.'; }
      if (problem && !confirm(problem + '\n\nConfirmar o recebimento mesmo assim? Só faça isso se você conferiu a transação por outro meio.')) return;
      await rpc('brlzx_redeem_received', { p_order_id: o.id, p_tx: tx });
      done('Recebimento confirmado. A proprietária já pode pagar o resgate.');
    },
    'find-client': async (fd) => {
      const rows = await rpc('brlzx_find_user', { p_email: fd.get('email') });
      if (!rows?.length) throw new Error('Não há conta com este e-mail.');
      const wallets = await rest(`brlzx_wallets?select=*&user_id=eq.${rows[0].id}&active=is.true`);
      st.foundClient = { ...rows[0], wallets };
    },
    'staff-wallet': async (fd) => {
      const a = String(fd.get('address')).trim();
      if (!isAddress(a)) throw new Error('Endereço de carteira inválido.');
      await rpc('brlzx_add_wallet', { p_address: a, p_label: null, p_user_id: st.foundClient.id });
      st.foundClient.wallets = await rest(`brlzx_wallets?select=*&user_id=eq.${st.foundClient.id}&active=is.true`);
      done('Carteira do cliente cadastrada.');
    },
    'staff-issue': async (fd) => {
      const cents = needCents(fd.get('amount'));
      await rpc('brlzx_request_issue', { p_amount_cents: cents, p_payment_method: fd.get('method'), p_wallet_address: fd.get('wallet'), p_user_id: st.foundClient.id, p_note: fd.get('note') || null });
      done('Ordem de emissão aberta em nome do cliente.');
    },
    attest: async (fd, form) => {
      const cash = zeroOrCents(fd.get('cash')); const bonds = zeroOrCents(fd.get('bonds'));
      const record = (tx) => rpc('brlzx_attest_reserve', { p_cash_cents: cash, p_bonds_cents: bonds, p_tx: tx, p_note: fd.get('note') || null });
      if (form.dataset.manual) { await record(needTx(fd.get('tx'))); done('Atestação registrada.'); return; }
      if (!confirm(`Atestar reserva total de ${fmtBRL(cash + bonds)}?\n\nConta: ${fmtBRL(cash)}\nTítulos públicos: ${fmtBRL(bonds)}`)) return;
      await chainThenRecord((k) => k.attestReserve(centsToUnits(cash + bonds)), record, 'Reserva atestada.');
    },
    compliance: async (fd) => {
      const a = String(fd.get('address')).trim(); const action = fd.get('action'); const reason = String(fd.get('reason')).trim();
      if (!isAddress(a)) throw new Error('Endereço inválido.');
      if (!reason) throw new Error('Informe o motivo.');
      const what = { bloquear: 'Bloquear', desbloquear: 'Desbloquear', destruir: 'DESTRUIR TODO O SALDO de' }[action];
      if (!confirm(`${what} ${a}?${action === 'destruir' ? '\n\nNão tem volta.' : ''}`)) return;
      const call = { bloquear: (k) => k.blockAccount(a), desbloquear: (k) => k.unblockAccount(a), destruir: (k) => k.destroyBlockedFunds(a) }[action];
      await chainThenRecord(call, (tx) => rpc('brlzx_compliance', { p_address: a, p_action: action, p_reason: reason, p_tx: tx }), 'Ação registrada.');
    },
    member: async (fd) => {
      await rpc('brlzx_set_member_by_email', { p_email: fd.get('email'), p_org: fd.get('org'), p_active: true });
      done('Pessoa incluída na equipe.');
    },
    network: async (fd) => {
      const contract = String(fd.get('contract')).trim(); const treasury = String(fd.get('treasury')).trim();
      if (contract && !isAddress(contract)) throw new Error('Endereço do contrato inválido.');
      if (treasury && !isAddress(treasury)) throw new Error('Endereço da tesouraria inválido.');
      await rpc('brlzx_save_network', { p_chain_id: Number(fd.get('chain')), p_contract: contract, p_treasury: treasury });
      done('Configuração da rede salva.');
    },
    deposit: async (fd) => {
      await rpc('brlzx_save_deposit', { p: Object.fromEntries(fd.entries()) });
      done('Dados de depósito salvos.');
    },
  };

  // Recarrega o que a tela mostra depois de cada ação.
  async function refresh() {
    const [settings, org] = await Promise.all([rest('brlzx_settings?select=*&id=eq.1'), rpc('brlzx_org')]);
    if (!alive) return;
    st.settings = settings?.[0] || null; st.org = org || null;
    if (view === 'backoffice') { await loadChain(); if (alive) await renderBackoffice(); }
    else await renderClient();
  }

  async function guarded(control, fn) {
    if (control.dataset.busy) return;
    control.dataset.busy = '1'; const buttons = control.matches('form') ? [...control.querySelectorAll('button')] : [control];
    buttons.forEach((b) => { b.disabled = true; });
    let keep = false;
    try { keep = (await fn()) === 'keep'; }
    catch (err) { keep = true; fail(err); }
    // Depois de erro ou de ação só de leitura, mantém o que a pessoa digitou; senão, recarrega a tela.
    // Os botões só voltam depois da recarga, para ninguém agir sobre dados velhos.
    try { if (alive && !keep) await refresh(); }
    catch (err) { fail(err); }
    finally { delete control.dataset.busy; buttons.forEach((b) => { b.disabled = false; }); }
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !root.contains(b)) return;
    const fn = clickActions[b.dataset.act];
    if (fn) { e.preventDefault(); guarded(b, () => fn(b)); }
  }, { signal });

  root.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = submitActions[form.dataset.form];
    if (fn) guarded(form, () => fn(new FormData(form), form));
  }, { signal });

  // Contagem regressiva do prazo de cobertura.
  ticker = setInterval(() => {
    const el = root.querySelector('#brlzx-countdown');
    if (el) el.textContent = fmtCountdown(Number(el.dataset.deadline) - Math.floor(Date.now() / 1000));
  }, 30000);

  if (!me) content.innerHTML = '<div class="panel"><p>Entre na sua conta para acessar o BRLZX.</p><a class="btn btn-dark" href="#/entrar">Entrar</a></div>';
  else refresh().catch((err) => { if (alive) { content.innerHTML = ''; say(`Não foi possível carregar o BRLZX: ${esc(err.message)}. Se o banco ainda não foi preparado, rode <code>db/brlzx.sql</code> no Supabase.`, 'error'); } });

  return () => { alive = false; controller.abort(); clearInterval(ticker); };
}
