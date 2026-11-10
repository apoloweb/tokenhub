// Autenticação real via Supabase Auth (GoTrue REST). Sem SDK.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const AUTH = SUPABASE_URL + '/auth/v1';
const base = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
const KEY = 'tokenhub:auth';

// Sessão em memória, carregada do localStorage na importação do módulo.
let session = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.access_token) return null;
    return s;
  } catch { return null; }
}
function save(s) {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
}
function store(json) {
  save({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at || (Math.floor(Date.now() / 1000) + (json.expires_in || 3600)),
    user: json.user ? { id: json.user.id, email: json.user.email } : null,
  });
  return session;
}

async function parse(res) {
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const msg = body?.msg || body?.error_description || body?.error || body?.message || ('Erro ' + res.status);
    const err = new Error(msg);
    err.code = body?.error_code || body?.error || res.status;
    throw err;
  }
  return body;
}

export function currentUser() { return session?.user || null; }
export function isLoggedIn() { return !!session?.access_token; }
export function accessToken() { return session?.access_token || null; }

// Renova o access_token usando o refresh_token. Se o refresh falhar (expirado/revogado),
// desloga; se for erro de rede, mantém a sessão atual.
let refreshing = null;
export async function refreshSession() {
  const rt = session?.refresh_token;
  if (!rt) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(AUTH + '/token?grant_type=refresh_token', { method: 'POST', headers: base, body: JSON.stringify({ refresh_token: rt }) });
      if (res.status === 400 || res.status === 401) { save(null); return null; }
      if (!res.ok) return session;
      const body = await res.json();
      if (body?.access_token) { store(body); return session; }
      return session;
    } catch { return session; }
    finally { refreshing = null; }
  })();
  return refreshing;
}

// Garante um token válido: renova se expirado ou perto de expirar.
export async function ensureFreshSession() {
  if (!session?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if ((session.expires_at || 0) - now < 120) return refreshSession();
  return session;
}

// Cadastro. Com confirmação de e-mail ligada, NÃO cria sessão: o usuário confirma pelo e-mail.
// Retorna { needsConfirmation: boolean }.
export async function signUp(email, password, meta = {}) {
  const res = await fetch(AUTH + '/signup', {
    method: 'POST', headers: base,
    body: JSON.stringify({ email, password, data: meta }),
  });
  const body = await parse(res);
  if (body?.access_token) { store(body); return { needsConfirmation: false }; }
  // Sem sessão retornada => confirmação de e-mail pendente.
  return { needsConfirmation: true };
}

export async function signIn(email, password) {
  const res = await fetch(AUTH + '/token?grant_type=password', {
    method: 'POST', headers: base,
    body: JSON.stringify({ email, password }),
  });
  const body = await parse(res);
  return store(body);
}

export async function signOut() {
  const token = session?.access_token;
  save(null);
  if (token) {
    try {
      await fetch(AUTH + '/logout', {
        method: 'POST',
        headers: { ...base, Authorization: 'Bearer ' + token },
      });
    } catch {}
  }
}

// Envia e-mail de redefinição de senha (fluxo nativo do Supabase).
export async function requestPasswordReset(email, redirectTo) {
  const url = AUTH + '/recover' + (redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : '');
  const res = await fetch(url, { method: 'POST', headers: base, body: JSON.stringify({ email }) });
  // O GoTrue responde 200 mesmo se o e-mail não existir (não revela cadastro).
  if (!res.ok) await parse(res);
  return { ok: true };
}

// Lê tokens que o Supabase devolve no fragmento da URL (link de recuperação/confirmação).
// Ex.: #access_token=...&type=recovery&refresh_token=...  → cria a sessão e diz o tipo.
export function ingestRecoveryTokens() {
  try {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (!raw.includes('access_token=')) return null;
    const p = new URLSearchParams(raw);
    const at = p.get('access_token');
    if (!at) return null;
    store({ access_token: at, refresh_token: p.get('refresh_token'), expires_in: Number(p.get('expires_in')) || 3600, user: null });
    const type = p.get('type') || 'token';
    history.replaceState(null, '', location.pathname + location.search + '#/' + (type === 'recovery' ? 'nova-senha' : ''));
    return type;
  } catch { return null; }
}

// Define uma nova senha usando a sessão atual (após o link de recuperação).
export async function updatePassword(password) {
  const token = session?.access_token;
  if (!token) throw new Error('Link de redefinição inválido ou expirado. Peça um novo e-mail.');
  const res = await fetch(AUTH + '/user', { method: 'PUT', headers: { ...base, Authorization: 'Bearer ' + token }, body: JSON.stringify({ password }) });
  const body = await parse(res);
  if (body?.id) save({ ...session, user: { id: body.id, email: body.email } });
  return body;
}

// Mensagens amigáveis em pt-BR para os erros mais comuns.
export function authMessage(err) {
  const m = (err?.message || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  if (m.includes('invalid login') || code.includes('invalid_credentials') || code.includes('invalid_grant'))
    return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed') || code.includes('email_not_confirmed'))
    return 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.';
  if (m.includes('already registered') || m.includes('already been registered') || code.includes('user_already_exists'))
    return 'Este e-mail já tem uma conta. Tente entrar.';
  if (m.includes('password') && m.includes('6'))
    return 'A senha precisa ter pelo menos 6 caracteres.';
  if (m.includes('rate limit') || code === '429')
    return 'Muitas tentativas. Aguarde um instante e tente de novo.';
  return err?.message || 'Não foi possível concluir. Tente novamente.';
}
