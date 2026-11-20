# TokenHub

Plataforma demonstrativa de tokenização de imóveis (site estático em ES modules), integrada ao **Supabase** para dados, autenticação e carteira por usuário.

## Como rodar (local)

O site é estático, mas precisa de um servidor HTTP (os módulos JS não funcionam abrindo o `index.html` por duplo clique):

```bash
python -m http.server 4189
```

Depois abra http://localhost:4189. Qualquer servidor estático serve (Node `http-server`, etc.).

## Supabase

Configuração pública (URL + anon key) em [`supabase-config.js`](supabase-config.js). A anon key é feita para o front-end; a segurança vem do **RLS** no banco. A `service_role` e a senha do banco **não** ficam no repositório.

O schema do banco está em [`db/`](db/) — rode cada arquivo no **SQL Editor** do Supabase:

| Arquivo | O que cria |
|---------|-----------|
| `db/opportunities.sql` | Tabela `opportunities` (oportunidades, leitura pública) |
| `db/wallet.sql` | `wallet_assets` (catálogo público) + `wallet_entries` (carteira por usuário: participante só lê, admin grava) |

Autenticação usa o **Supabase Auth** (e-mail/senha) — ver [`auth.js`](auth.js).

### Camadas de integração

- `supabase.js` — carrega as oportunidades do banco (fallback para fixtures de `data.js`).
- `auth.js` — cadastro, login, logout e sessão (GoTrue REST).
- `wallet-sync.js` — carrega a carteira do usuário logado (somente leitura; conta nova começa vazia); visitante usa a carteira de exemplo.

## Observações

- Ambiente de demonstração: oportunidades e carteira iniciais são fictícias.
- Alguns fluxos (depositar, sacar, aplicar, OTC) ainda são simulações e não gravam no banco.
