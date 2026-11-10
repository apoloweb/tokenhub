// Painel admin: CRUD de imóveis/anúncios (tabela opportunities).
// Escrita via RLS (admin). Leitura pública.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { accessToken } from './auth.js?v=v8';

const CATS = ['Imobiliário', 'Energia', 'Agronegócio', 'Recebíveis', 'Outros'];
const ARTS = [['urban', 'Urbano / Imóvel'], ['solar', 'Energia / Solar'], ['agro', 'Agro / Campo'], ['flow', 'Recebíveis / Fluxo']];
const RISKS = ['Baixo', 'Médio', 'Alto'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const headers = (extra = {}) => ({ apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || SUPABASE_ANON_KEY), ...extra });
const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function listOpps() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/opportunities?select=*&order=sort_order.asc', { headers: headers() });
  if (!r.ok) throw new Error('Não foi possível listar (' + r.status + ')');
  return r.json();
}
async function saveOpp(row, isNew) {
  const url = SUPABASE_URL + '/rest/v1/opportunities' + (isNew ? '' : '?id=eq.' + encodeURIComponent(row.id));
  const r = await fetch(url, { method: isNew ? 'POST' : 'PATCH', headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}
async function deleteOpp(id) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/opportunities?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

// Envia a imagem para o bucket "imoveis" e devolve a URL pública.
async function uploadImage(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/imoveis/' + path, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || ''), 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: file,
  });
  if (!r.ok) throw new Error('Falha no upload da imagem: ' + ((await r.text()) || r.status));
  return SUPABASE_URL + '/storage/v1/object/public/imoveis/' + path;
}

const sel = (label, name, opts, val) => `<div class="field"><label>${label}</label><select name="${name}">${opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(l)}</option>`; }).join('')}</select></div>`;

export function opportunitiesBody() {
  return `<div id="opp-root">
    <div class="app-heading"><div><span class="eyebrow">Administração</span><h1>Imóveis &amp; anúncios</h1><p>Crie, edite e remova as oportunidades que aparecem no site.</p></div></div>
    <section class="panel"><h2 id="opp-form-title">Novo imóvel</h2>
      <form id="opp-form" class="form-grid" autocomplete="off">
        <input type="hidden" name="_mode" value="new">
        <div class="field"><label>Identificador (slug)</label><input name="id" placeholder="ex.: residencial-centro" required></div>
        <div class="field"><label>Nome</label><input name="name" required maxlength="120"></div>
        <div class="field"><label>Emissor / fonte</label><input name="issuer" maxlength="160"></div>
        ${sel('Categoria', 'category', CATS, 'Imobiliário')}
        <div class="field"><label>Rentabilidade (% a.a.)</label><input name="rate" type="number" step="0.1" value="12"></div>
        <div class="field"><label>Prazo (meses)</label><input name="term" type="number" value="24"></div>
        <div class="field"><label>Investimento mínimo (R$)</label><input name="min" type="number" value="100"></div>
        <div class="field"><label>Captado (R$)</label><input name="raised" type="number" value="0"></div>
        <div class="field"><label>Meta (R$)</label><input name="goal" type="number" value="1000000"></div>
        <div class="field"><label>Captação (%)</label><input name="progress" type="number" step="0.1" value="0"></div>
        <div class="field"><label>Dias restantes</label><input name="remaining" type="number" value="30"></div>
        ${sel('Risco', 'risk', RISKS, 'Alto')}
        ${sel('Arte (fallback)', 'art', ARTS, 'urban')}
        <div class="field" style="grid-column:1/-1"><label>Foto do imóvel (upload)</label><input type="file" name="imagefile" accept="image/*"><input type="hidden" name="image_url"><small class="hint">JPG, PNG ou WebP. Se não enviar, usa a arte selecionada acima.</small><div id="opp-image-preview" style="margin-top:8px"></div></div>
        <div class="field" style="grid-column:1/-1"><label>Descrição</label><textarea name="description" rows="3" maxlength="900"></textarea></div>
        <div class="field"><label>Ordem de exibição</label><input name="sort_order" type="number" value="99"></div>
        <div style="grid-column:1/-1"><button type="submit" class="btn btn-dark">Salvar imóvel</button> <button type="button" class="btn btn-outline" data-opp="novo">Limpar / novo</button><span id="opp-msg" role="status" style="margin-left:12px"></span></div>
      </form>
    </section>
    <section class="panel" style="margin-top:20px"><h2>Imóveis cadastrados</h2><div id="opp-list" style="overflow-x:auto"><p class="small">Carregando…</p></div></section>
  </div>`;
}

export function mountOpportunities(app, { toast, onChange } = {}) {
  const root = app.querySelector('#opp-root');
  if (!root) return () => {};
  const controller = new AbortController(); const { signal } = controller;
  const form = root.querySelector('#opp-form');
  const msg = root.querySelector('#opp-msg');
  const notify = (m) => (toast ? toast(m) : null);
  const FIELDS = ['name', 'issuer', 'category', 'rate', 'term', 'min', 'raised', 'goal', 'progress', 'remaining', 'risk', 'art', 'description', 'sort_order', 'image_url'];
  let cache = [];
  const preview = (url) => { const el = root.querySelector('#opp-image-preview'); if (el) el.innerHTML = url ? `<img src="${esc(url)}" alt="" style="max-width:240px;border-radius:10px;display:block">` : ''; };

  function fillForm(o) {
    form.elements.imagefile.value = '';
    if (!o) { form.reset(); form.elements._mode.value = 'new'; form.elements.id.readOnly = false; root.querySelector('#opp-form-title').textContent = 'Novo imóvel'; preview(''); return; }
    form.elements._mode.value = 'edit';
    root.querySelector('#opp-form-title').textContent = 'Editar: ' + o.name;
    form.elements.id.value = o.id; form.elements.id.readOnly = true;
    FIELDS.forEach((k) => { if (form.elements[k]) form.elements[k].value = o[k] ?? ''; });
    preview(o.image_url);
  }

  // Pré-visualiza a foto escolhida antes de enviar.
  form.elements.imagefile.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) preview(URL.createObjectURL(f));
  }, { signal });

  async function refresh() {
    const box = root.querySelector('#opp-list');
    try {
      cache = await listOpps();
      box.innerHTML = `<table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left"><th>Nome</th><th>Categoria</th><th>% a.a.</th><th>Captação</th><th></th></tr></thead><tbody>${cache.map((o) => `<tr style="border-top:1px solid rgba(0,0,0,.08)"><td>${esc(o.name)}</td><td>${esc(o.category || '')}</td><td>${o.rate}%</td><td>${o.progress}%</td><td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-opp="edit" data-id="${esc(o.id)}">Editar</button> <button class="btn btn-outline btn-sm" data-opp="del" data-id="${esc(o.id)}" style="margin-left:6px">Apagar</button></td></tr>`).join('')}</tbody></table>`;
    } catch (e) { box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const isNew = form.elements._mode.value === 'new';
    const fd = new FormData(form);
    const id = slug(fd.get('id'));
    if (!id) { msg.innerHTML = '<span class="form-error">Informe um identificador.</span>'; return; }
    const btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      let image_url = fd.get('image_url') || null;
      const file = form.elements.imagefile.files[0];
      if (file) { msg.innerHTML = 'Enviando imagem…'; image_url = await uploadImage(file); }
      msg.innerHTML = 'Salvando…';
      const row = { id, name: fd.get('name'), issuer: fd.get('issuer') || null, category: fd.get('category'), rate: num(fd.get('rate')), term: Math.round(num(fd.get('term'))), min: num(fd.get('min')), raised: num(fd.get('raised')), goal: num(fd.get('goal')), progress: num(fd.get('progress')), remaining: Math.round(num(fd.get('remaining'))), risk: fd.get('risk'), art: fd.get('art'), description: fd.get('description') || null, sort_order: Math.round(num(fd.get('sort_order'))), image_url };
      await saveOpp(row, isNew);
      msg.innerHTML = '<span class="form-success">Imóvel salvo.</span>'; fillForm(null); await refresh(); onChange && onChange();
    }
    catch (err) { msg.innerHTML = `<span class="form-error">${esc(err.message)}</span>`; }
    finally { btn.disabled = false; }
  }, { signal });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-opp]'); if (!b) return;
    const kind = b.dataset.opp;
    if (kind === 'novo') { fillForm(null); msg.innerHTML = ''; return; }
    if (kind === 'edit') { const o = cache.find((x) => x.id === b.dataset.id); if (o) { fillForm(o); form.scrollIntoView({ behavior: 'smooth', block: 'start' }); } return; }
    if (kind === 'del') {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.dataset.label = b.textContent; b.textContent = 'Confirmar?'; b.classList.add('btn-dark'); setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = b.dataset.label; b.classList.remove('btn-dark'); } }, 5000); return; }
      b.disabled = true;
      try { await deleteOpp(b.dataset.id); notify('Imóvel apagado.'); await refresh(); onChange && onChange(); }
      catch (err) { notify(err.message); b.disabled = false; }
    }
  }, { signal });

  refresh();
  return () => controller.abort();
}
