// Edge Function: admin-users
// Backend seguro para gestão de usuários. Só admins podem usar.
// A service_role é injetada pelo Supabase (Deno.env) — NUNCA fica no front-end.
//
// Deploy (painel): Edge Functions > Deploy a new function > nome "admin-users" > cole este código.
// Ou CLI: supabase functions deploy admin-users
import { createClient } from 'jsr:@supabase/supabase-js@2';

const ALLOWED_ROLES = ['admin', 'secretario', 'portaria', 'usuario', 'apostador'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Método não permitido' });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Identifica quem chamou pelo JWT.
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!jwt) return json(401, { error: 'Sem token' });
    const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
    if (whoErr || !who?.user) return json(401, { error: 'Não autenticado' });

    // Confere se é admin.
    const { data: prof } = await admin.from('profiles').select('role').eq('id', who.user.id).single();
    if (prof?.role !== 'admin') return json(403, { error: 'Apenas administradores' });

    const body = await req.json();
    const action = body?.action;

    if (action === 'create') {
      const { email, password, role = 'usuario', full_name } = body;
      if (!email || !password) return json(400, { error: 'E-mail e senha são obrigatórios' });
      if (!ALLOWED_ROLES.includes(role)) return json(400, { error: 'Papel inválido' });
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name: full_name || '' },
      });
      if (error) return json(400, { error: error.message });
      await admin.from('profiles').update({ role, full_name: full_name || null }).eq('id', created.user.id);
      return json(200, { ok: true, id: created.user.id, email });
    }

    if (action === 'setRole') {
      const { userId, role } = body;
      if (!userId || !ALLOWED_ROLES.includes(role)) return json(400, { error: 'Dados inválidos' });
      const { error } = await admin.from('profiles').update({ role }).eq('id', userId);
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true });
    }

    if (action === 'resetPassword') {
      const { userId, password } = body;
      if (!userId || !password) return json(400, { error: 'Dados inválidos' });
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true });
    }

    if (action === 'delete') {
      const { userId } = body;
      if (!userId) return json(400, { error: 'Dados inválidos' });
      if (userId === who.user.id) return json(400, { error: 'Você não pode apagar a si mesmo' });
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json(400, { error: error.message });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Ação desconhecida' });
  } catch (e) {
    return json(500, { error: String((e as Error)?.message || e) });
  }
});
