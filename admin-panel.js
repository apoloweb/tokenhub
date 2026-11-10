// Painel admin interno: gestão de usuários e papéis.
// Leitura/edição de papéis via RLS (admin). Criar/apagar/resetar senha via Edge Function.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { accessToken, currentUser } from './auth.js?v=v7';

export const ROLES = [
  ['admin', 'Administrador'],
  ['secretario', 'Secretário'],
  ['portaria', 'Portaria'],
  ['usuario', 'Usuário'],
  ['apostador', 'Apostador'],
];
const roleLabel = (r) => (ROLES.find((x) => x[0] === r)?.[1]) || r;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function authHeaders(extra = {}) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (accessToken() || SUPABASE_ANON_KEY), ...extra };
}

// Papel do usuário logado (RLS: lê o próprio). Default 'usuario'.
export async function fetchMyRole() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=role&limit=1', { headers: authHeaders() });
  if (!r.ok) return 'usuario';
  const rows = await r.json();
  return rows?.[0]?.role || 'usuario';
}

// Perfil do usuário logado (para a página Meu perfil).
export async function fetchMyProfile() {
  let r = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=email,full_name,username,phone,role&limit=1', { headers: authHeaders() });
  if (!r.ok) r = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=email,full_name,role&limit=1', { headers: authHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

export async function saveMyProfile(fields) {
  const u = currentUser();
  if (!u) throw new Error('Não autenticado');
  const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + u.id, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(fields),
  });
  if (!r.ok) throw new Error((await r.text()) || ('Erro ' + r.status));
}

async function listUsers() {
  const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=id,email,full_name,role,created_at&order=created_at.asc', { headers: authHeaders() });
  if (!r.ok) throw new Error('Não foi possível listar (' + r.status + ')');
  return r.json();
}

async function callAdmin(action, payload = {}) {
  const r = await fetch(SUPABASE_URL + '/functions/v1/admin-users', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action, ...payload }),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || ('Erro ' + r.status + ' (a Edge Function foi publicada?)'));
  return data;
}

function genPassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const n = crypto.getRandomValues(new Uint32Array(12));
  return 'Th-' + [...n].map((x) => a[x % a.length]).join('') + '-#9';
}

export function adminBody() {
  const roleOptions = ROLES.map(([v, l]) => `<option value="${v}"${v === 'usuario' ? ' selected' : ''}>${l}</option>`).join('');
  return `<div id="admin-root">
    ${(typeof heading === 'function') ? '' : ''}
    <div class="app-heading"><div><span class="eyebrow">Administração</span><h1>Usuários e papéis</h1><p>Crie contas, defina o papel de cada pessoa e gerencie os acessos.</p></div></div>

    <section class="panel" aria-label="Criar usuário">
      <h2>Criar usuário</h2>
      <form id="admin-create-form" class="form-grid" autocomplete="off">
        <div class="field"><label for="au-name">Nome</label><input id="au-name" name="full_name" maxlength="100" placeholder="Nome da pessoa"></div>
        <div class="field"><label for="au-email">E-mail</label><input id="au-email" name="email" type="email" required placeholder="email@dominio.com"></div>
        <div class="field"><label for="au-pass">Senha</label><div class="row" style="gap:8px"><input id="au-pass" name="password" required minlength="8" placeholder="mín. 8 caracteres" style="flex:1"><button type="button" class="btn btn-outline btn-sm" data-admin="gen">Gerar</button></div></div>
        <div class="field"><label for="au-role">Papel</label><select id="au-role" name="role">${roleOptions}</select></div>
        <div style="grid-column:1/-1"><button type="submit" class="btn btn-dark">Criar usuário</button><span id="admin-create-msg" role="status" style="margin-left:12px"></span></div>
      </form>
    </section>

    <section class="panel" aria-label="Usuários" style="margin-top:20px">
      <h2>Usuários</h2>
      <div id="admin-users-feedback" role="status"></div>
      <div id="admin-users" style="overflow-x:auto"><p class="small">Carregando usuários…</p></div>
    </section>
  </div>`;
}

export function mountAdmin(app, { toast } = {}) {
  const root = app.querySelector('#admin-root');
  if (!root) return () => {};
  const controller = new AbortController();
  const { signal } = controller;
  const notify = (m) => (toast ? toast(m) : null);
  const me = currentUser();

  const rolePicker = (id, current) => `<select data-admin-role="${id}">${ROLES.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

  async function refresh() {
    const box = root.querySelector('#admin-users');
    try {
      const users = await listUsers();
      box.innerHTML = `<table class="admin-table" style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left"><th>E-mail</th><th>Nome</th><th>Papel</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-row="${u.id}" style="border-top:1px solid rgba(0,0,0,.08)">
          <td>${esc(u.email)}${u.id === me?.id ? ' <span class="badge badge-blue">você</span>' : ''}</td>
          <td>${esc(u.full_name) || '—'}</td>
          <td>${rolePicker(u.id, u.role)}</td>
          <td style="white-space:nowrap"><button class="btn btn-outline btn-sm" data-admin="reset" data-id="${u.id}" data-email="${esc(u.email)}">Resetar senha</button>
          ${u.id === me?.id ? '' : `<button class="btn btn-outline btn-sm" data-admin="delete" data-id="${u.id}" data-email="${esc(u.email)}" style="margin-left:6px">Apagar</button>`}</td>
        </tr>`).join('')}</tbody></table>`;
    } catch (e) {
      box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`;
    }
  }

  // Criar usuário
  root.querySelector('#admin-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (!f.reportValidity()) return;
    const msg = root.querySelector('#admin-create-msg');
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true; msg.innerHTML = 'Criando…';
    try {
      const fd = new FormData(f);
      await callAdmin('create', { email: fd.get('email'), password: fd.get('password'), role: fd.get('role'), full_name: fd.get('full_name') });
      msg.innerHTML = '<span class="form-success">Usuário criado.</span>';
      f.reset();
      await refresh();
    } catch (err) {
      msg.innerHTML = `<span class="form-error">${esc(err.message)}</span>`;
    } finally { btn.disabled = false; }
  }, { signal });

  // Ações: gerar senha (1 clique); apagar/resetar com confirmação em 2 cliques
  // (sem confirm() nativo — vários navegadores bloqueiam e o botão parece não reagir).
  const disarm = (b) => { clearTimeout(b._t); b.dataset.armed = ''; if (b.dataset.label) b.textContent = b.dataset.label; b.classList.remove('btn-dark'); };
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-admin]');
    if (!b) return;
    const kind = b.dataset.admin;
    const fb = root.querySelector('#admin-users-feedback');

    if (kind === 'gen') { root.querySelector('#au-pass').value = genPassword(); return; }
    if (kind !== 'delete' && kind !== 'reset') return;

    // 1º clique: arma a confirmação. Reseta outros botões armados.
    if (b.dataset.armed !== '1') {
      root.querySelectorAll('[data-admin][data-armed="1"]').forEach(disarm);
      b.dataset.armed = '1';
      b.dataset.label = b.dataset.label || b.textContent;
      b.textContent = kind === 'delete' ? 'Confirmar exclusão' : 'Confirmar reset';
      b.classList.add('btn-dark');
      b._t = setTimeout(() => { if (b.isConnected) disarm(b); }, 5000);
      return;
    }

    // 2º clique: executa.
    disarm(b); b.disabled = true;
    try {
      if (kind === 'delete') {
        await callAdmin('delete', { userId: b.dataset.id });
        if (fb) fb.innerHTML = `<span class="form-success">Usuário ${esc(b.dataset.email)} apagado.</span>`;
        notify('Usuário apagado.');
        await refresh();
      } else {
        const pass = genPassword();
        await callAdmin('resetPassword', { userId: b.dataset.id, password: pass });
        if (fb) fb.innerHTML = `<div class="form-success">Nova senha de ${esc(b.dataset.email)}: <code>${esc(pass)}</code><br><small>Copie agora — não será mostrada de novo.</small></div>`;
        notify('Senha redefinida.');
        b.disabled = false;
      }
    } catch (err) {
      if (fb) fb.innerHTML = `<span class="form-error">${esc(err.message)}</span>`;
      b.disabled = false;
    }
  }, { signal });

  // Troca de papel
  root.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-admin-role]');
    if (!sel) return;
    const userId = sel.dataset.adminRole, role = sel.value;
    try { await callAdmin('setRole', { userId, role }); notify('Papel atualizado para ' + roleLabel(role) + '.'); }
    catch (err) { notify(err.message); sel.value = sel.dataset.prev || role; }
  }, { signal });

  refresh();
  return () => controller.abort();
}
