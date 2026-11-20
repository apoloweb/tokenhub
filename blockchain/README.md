# Stablecoin BRL — smart contract

Token ERC-20 lastreado 1:1 em reais, de circulação pública, na rede Polygon (homologação na testnet Amoy).
Nome e símbolo: BRLZX (padrão do script de deploy).

## O que o contrato faz

| Função | Quem pode | Regra |
|---|---|---|
| `mint(to, amount, ref)` | `MINTER_ROLE` | Cada emissão leva uma referência única: o ID da ordem de emissão no backoffice, qualquer que seja o meio de pagamento. A mesma referência não emite duas vezes. Trava se houver supply descoberto há mais que o prazo de cobertura. |
| `proposeMint` / `approveMint` / `cancelMint` | `MINTER_ROLE` propõe, `APPROVER_ROLE` aprova | Caminho obrigatório quando a emissão deixaria o total descoberto acima de R$ 100 mil. Quem propôs não aprova. |
| `setDualApprovalThreshold(valor)` | admin | Altera o limite de dupla aprovação (padrão R$ 100 mil). |
| `redeem(amount, ref)` | `BURNER_ROLE` | Queima do saldo da própria tesouraria, com referência única do pedido de resgate. |
| `attestReserve(valor)` | `RESERVE_ROLE` | Registra o lastro atestado (conta + títulos públicos). Se cobrir todo o supply, zera o prazo de cobertura. |
| `setCoverageWindow(seg)` | admin | Altera o prazo de cobertura (padrão 48h, máximo 7 dias). |
| `blockAccount` / `unblockAccount` | `COMPLIANCE_ROLE` | Endereço bloqueado não envia, não recebe e não movimenta saldo de terceiros. |
| `destroyBlockedFunds(conta)` | `COMPLIANCE_ROLE` | Queima o saldo de endereço bloqueado (ordem judicial). |
| `pause()` | `PAUSER_ROLE` | Trava transferências, emissão e resgate. |
| `unpause()` | admin | Só o admin retoma. |
| upgrade | admin | Padrão UUPS. A troca de admin tem atraso obrigatório (padrão: 2 dias). |

Também inclui `permit` (EIP-2612) e 6 casas decimais (R$ 1,00 = 1.000.000 unidades).

## Prazo de cobertura (48h)

A tesouraria pode emitir antes de o lastro estar constituído. Quando o supply passa da reserva atestada,
o contrato marca o início do período descoberto e publica a data-limite (`coverageDeadline()`).
Dentro do prazo, as emissões seguem normalmente. Se o prazo vencer sem `attestReserve` cobrindo todo o supply,
novas emissões ficam travadas até a cobertura integral; transferências e resgates não são afetados.
O relógio conta a partir do primeiro instante descoberto e só zera com cobertura integral.
`uncoveredSupply()` mostra, a qualquer momento, quanto está sem lastro atestado — é público.

## Dupla aprovação (total descoberto acima de R$ 100 mil)

A cada emissão, o contrato calcula o total que ficaria sem lastro atestado depois dela (o que já estava descoberto mais a parcela nova).
Se esse total ficar em até R$ 100 mil, o `mint` direto funciona. Acima disso, o `mint` direto é recusado:
a TokenHub propõe (`proposeMint`) e a proprietária aprova (`approveMint`), o que executa a emissão.
Como o limite é sobre o acumulado, fracionar em emissões menores não contorna a regra.
Emissão totalmente coberta pela reserva não exige segunda aprovação, qualquer que seja o valor.
Quando a proprietária atesta a reserva e o descoberto volta a zero, a margem de R$ 100 mil é restabelecida.

O admin não emite: ele só distribui papéis, despausa e faz upgrade. Use carteiras diferentes para cada papel.

## Papéis por empresa

A TokenHub é a emissora; a proprietária do token é outra empresa, titular da conta e dos títulos da reserva.

| Papel | Empresa | Motivo |
|---|---|---|
| Admin (multisig) | Proprietária | Concede papéis, faz upgrade, despausa, define prazo de cobertura e limite de dupla aprovação. |
| `RESERVE_ROLE` | Proprietária | É quem detém o lastro; a emissora depende dela para zerar o prazo de 48h. |
| `MINTER_ROLE` | TokenHub | Emite e propõe emissões. |
| `BURNER_ROLE` | TokenHub (tesouraria) | Queima após a proprietária pagar o resgate em reais. |
| `PAUSER_ROLE` | TokenHub e proprietária | Qualquer uma pausa em emergência; só a proprietária despausa. |
| `COMPLIANCE_ROLE` | TokenHub | Bloqueio de endereços. |
| `APPROVER_ROLE` | Proprietária | Segunda assinatura das emissões descobertas acima do limite: a TokenHub propõe, a proprietária aprova. |

Os papéis são concedidos no próprio deploy; a carteira que faz o deploy não fica com nenhum.
Para trocar de emissora, a proprietária revoga os papéis da TokenHub e concede à nova: o endereço do token e os saldos não mudam.

## Fluxo com o backoffice

- **Emissão:** backoffice abre uma ordem de emissão (Pix, TED, boleto, transferência interna ou dinheiro) → a emissora executa `mint(carteira, valor, ref)`, em que `ref` é a referência de 32 bytes gerada para a ordem (coluna `ref` de `brlzx_orders`). Se o total descoberto passar do limite, a emissora usa `proposeMint` e a proprietária `approveMint`.
- **Resgate:** cliente envia tokens para a tesouraria → a emissora confirma o recebimento → a proprietária paga em reais → a emissora executa `redeem(valor, ref)`.
- **Reserva:** em até 48h da emissão, o valor entra em conta ou em títulos públicos e a tesouraria registra `attestReserve(total)`.
- Os eventos `Minted`, `Redeemed` e `ReserveAttested` são a base da conciliação reserva × supply.

## Rodar

```bash
npm install
npx hardhat test          # 42 testes
```

Deploy em testnet (a chave de deploy é só para homologação):

```bash
export DEPLOYER_PRIVATE_KEY=0x...            # só paga o gás; não recebe papel
export OWNER_ADMIN_ADDRESS=0x...             # proprietária (multisig)
export OWNER_RESERVE_ADDRESS=0x...           # proprietária: atesta a reserva
export TOKENHUB_MINTER_ADDRESS=0x...
export TOKENHUB_TREASURY_ADDRESS=0x...
export TOKENHUB_PAUSER_ADDRESS=0x...
export TOKENHUB_COMPLIANCE_ADDRESS=0x...
export OWNER_APPROVER_ADDRESS=0x...          # proprietária: 2ª assinatura
npx hardhat run scripts/deploy.js --network polygonAmoy
```

Para mainnet, a rede `polygon` já está no `hardhat.config.js` (defina `POLYGON_RPC_URL`).

## Antes de mainnet

- Auditoria externa do contrato.
- Admin em multisig; papéis operacionais em carteiras separadas (idealmente HSM/custódia).
- Definir quem detém `RESERVE_ROLE` (ex.: tesouraria com dupla aprovação, ou o atestador).
- Decidir casas decimais, nome e símbolo — não mudam depois sem upgrade.
- Verificar o código-fonte no explorador da rede.
