# BRLZX no TokenHub

Stablecoin lastreada em reais. A TokenHub é a **emissora**; a **proprietária** do token é outra empresa, titular da conta e dos títulos da reserva.

## Onde está cada coisa

| Parte | Arquivo |
|---|---|
| Contrato (Polygon) | `blockchain/` — ver `blockchain/README.md` |
| Banco (Supabase) | `db/brlzx.sql` — só objetos novos, prefixo `brlzx_` |
| Regras puras das telas | `brlzx-core.js` (+ `brlzx-core.test.mjs`) |
| Telas | `brlzx.js` |
| Área do cliente | `#/app/brlzx` |
| Backoffice (emissora e proprietária) | `#/app/brlzx/backoffice` |

## Quem faz o quê

| Ato | Emissora (TokenHub) | Proprietária |
|---|---|---|
| Emitir direto (total descoberto até R$ 100 mil) | ✔ | |
| Propor emissão acima do limite | ✔ | |
| Aprovar emissão proposta (2ª assinatura) | | ✔ |
| Confirmar tokens recebidos no resgate | ✔ | |
| Pagar o resgate em reais | | ✔ |
| Queimar tokens do resgate | ✔ | |
| Atestar a reserva | | ✔ |
| Bloquear / desbloquear endereço | ✔ | |
| Pausar | ✔ | ✔ |
| Retomar, upgrade, conceder papéis, mudar limites | | ✔ (admin do contrato) |
| Alterar dados de depósito | | ✔ |

O cliente cadastra carteiras, pede emissão e resgate, cancela ordem ainda não iniciada e consulta o próprio extrato. Não edita nem apaga nada.

## Como as transações são assinadas

Na carteira do navegador de quem opera (MetaMask ou similar). Nenhuma chave privada fica no site nem no Supabase.
Cada ato na rede é registrado no backoffice com o hash da transação; se o registro falhar depois da confirmação na rede,
a tela mostra o hash para registrar à mão em "Já executei na rede: informar hash".

## Colocar no ar

1. Rodar `db/brlzx.sql` no SQL Editor do Supabase.
2. Publicar o contrato (`blockchain/scripts/deploy.js`) com as carteiras das duas empresas.
3. Como administrador do TokenHub, em Backoffice → Equipe e configuração: incluir a equipe da emissora, incluir a **primeira** pessoa da proprietária e informar rede, contrato e tesouraria.
4. A proprietária entra, informa os dados de depósito, inclui o restante da própria equipe e atesta a reserva.

## Testes

```bash
node brlzx-core.test.mjs                 # regras puras
cd blockchain && npm install && npx hardhat test   # contrato
# SQL: ver db/tests/README.md
tests/e2e/run.sh                         # telas + SQL + contrato, tudo local (Postgres, Hardhat, Chrome)
```

## Limites conhecidos

- O backoffice confere na rede o envio de tokens do resgate; os demais hashes informados à mão não são conferidos automaticamente. A aba "Cobertura e reserva" acusa divergência entre a rede e o backoffice.
- Sem integração de KYC: a ordem exige carteira cadastrada, não cadastro aprovado.
- Pausa e retomada ficam registradas só na rede, não na trilha do backoffice.
- O contrato não passou por auditoria externa.
