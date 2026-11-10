// Acesso leve ao Supabase via REST (sem SDK). Fatia 1: oportunidades (leitura pública).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const REST = SUPABASE_URL + '/rest/v1';
const headers = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY };

const COLS = 'id,name,issuer,category,rate,term,min,raised,goal,progress,remaining,risk,art,description';

// Busca as oportunidades no banco e substitui o conteúdo de `target` no lugar (mantém a mesma
// referência do array que o app.js importou). Em erro (rede/banco fora), lança — o chamador
// mantém os fixtures locais como fallback.
export async function loadOpportunities(target) {
  const res = await fetch(REST + '/opportunities?select=' + COLS + '&order=sort_order.asc', { headers });
  if (!res.ok) throw new Error('Supabase opportunities ' + res.status);
  const rows = await res.json();
  if (Array.isArray(rows) && rows.length) {
    const clean = rows.map(r => ({
      id: r.id, name: r.name, issuer: r.issuer, category: r.category,
      rate: Number(r.rate), term: Number(r.term), min: Number(r.min),
      raised: Number(r.raised), goal: Number(r.goal), progress: Number(r.progress),
      remaining: Number(r.remaining), risk: r.risk, art: r.art, description: r.description,
    }));
    target.splice(0, target.length, ...clean);
  }
  return target;
}
