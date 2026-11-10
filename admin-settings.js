// Painel admin: configurações gerais (conta de depósito + contrato padrão).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { accessToken } from './auth.js?v=v8';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const headers = (extra = {}) => ({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || SUPABASE_ANON_KEY), ...extra });

async function loadSettings() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_settings?select=key,value', { headers: headers() });
  if (!r.ok) return {};
  const rows = await r.json();
  const map = {};
  for (const row of rows) map[row.key] = row.value || {};
  return map;
}

async function saveSetting(key, value) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/app_settings?key=eq.' + encodeURIComponent(key), {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

export function settingsBody() {
  const f = (label, name, hint) => `<div class="field"><label>${label}</label><input name="${name}" placeholder="${hint || ''}"></div>`;
  return `<div id="settings-root">
    <div class="app-heading"><div><span class="eyebrow">Administração</span><h1>Configurações</h1><p>Conta para depósito e modelo de contrato das participações.</p></div></div>

    <section class="panel"><h2>Conta para depósito</h2>
      <p class="small">O que o participante vê na hora de depositar.</p>
      <form id="deposit-form" class="form-grid" autocomplete="off">
        ${f('Chave PIX', 'pix', 'CNPJ, e-mail, telefone ou aleatória')}
        ${f('Titular', 'titular', 'Nome do titular da conta')}
        ${f('CPF/CNPJ do titular', 'documento', '')}
        ${f('Banco', 'banco', '')}
        ${f('Agência', 'agencia', '')}
        ${f('Conta', 'conta', '')}
        <div class="field" style="grid-column:1/-1"><label>Instruções adicionais</label><textarea name="instrucoes" rows="2" placeholder="Ex.: envie o comprovante após o PIX"></textarea></div>
        <div style="grid-column:1/-1"><button type="submit" class="btn btn-dark">Salvar conta</button><span id="deposit-msg" role="status" style="margin-left:12px"></span></div>
      </form>
    </section>

    <section class="panel" style="margin-top:20px"><h2>Modelo de contrato</h2>
      <p class="small">Placeholders disponíveis: <code>{{nome}} {{cpf}} {{tokens}} {{projeto}} {{valor}} {{data}} {{estrutura}} {{sociedade}} {{cnpj}} {{socio_ostensivo}}</code></p>
      <form id="contract-form" autocomplete="off">
        <div class="field"><textarea name="texto" rows="12" style="width:100%;font-family:monospace;font-size:13px"></textarea></div>
        <div><button type="submit" class="btn btn-dark">Salvar contrato</button><span id="contract-msg" role="status" style="margin-left:12px"></span></div>
      </form>
      <p class="small" style="margin-top:12px">⚠️ Minuta sujeita à validação do seu advogado. Não é aconselhamento jurídico.</p>
    </section>
  </div>`;
}

export function mountSettings(app, { toast } = {}) {
  const root = app.querySelector('#settings-root');
  if (!root) return () => {};
  const controller = new AbortController(); const { signal } = controller;
  const depForm = root.querySelector('#deposit-form');
  const conForm = root.querySelector('#contract-form');

  (async () => {
    const s = await loadSettings();
    const dep = s.deposit_account || {};
    ['pix', 'titular', 'documento', 'banco', 'agencia', 'conta', 'instrucoes'].forEach((k) => { if (depForm.elements[k]) depForm.elements[k].value = dep[k] || ''; });
    conForm.elements.texto.value = (s.contract_template || {}).texto || '';
  })();

  depForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = root.querySelector('#deposit-msg'); const btn = depForm.querySelector('button'); btn.disabled = true; msg.innerHTML = 'Salvando…';
    try {
      const fd = new FormData(depForm);
      await saveSetting('deposit_account', { pix: fd.get('pix'), titular: fd.get('titular'), documento: fd.get('documento'), banco: fd.get('banco'), agencia: fd.get('agencia'), conta: fd.get('conta'), instrucoes: fd.get('instrucoes') });
      msg.innerHTML = '<span class="form-success">Conta salva.</span>'; toast && toast('Conta de depósito salva.');
    } catch (err) { msg.innerHTML = `<span class="form-error">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  }, { signal });

  conForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = root.querySelector('#contract-msg'); const btn = conForm.querySelector('button'); btn.disabled = true; msg.innerHTML = 'Salvando…';
    try {
      await saveSetting('contract_template', { texto: conForm.elements.texto.value });
      msg.innerHTML = '<span class="form-success">Contrato salvo.</span>'; toast && toast('Modelo de contrato salvo.');
    } catch (err) { msg.innerHTML = `<span class="form-error">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  }, { signal });

  return () => controller.abort();
}
