// BRLZX — regras puras (sem DOM, sem rede), usadas pelas telas e cobertas por brlzx-core.test.mjs.

// 1 centavo = 10.000 unidades do token (6 casas decimais).
export const UNITS_PER_CENT = 10000n;
export const centsToUnits = (cents) => BigInt(cents) * UNITS_PER_CENT;
export const unitsToCents = (units) => Number(BigInt(units) / UNITS_PER_CENT);

export const NETWORKS = {
  137: { name: 'Polygon', rpc: 'https://polygon-rpc.com', explorer: 'https://polygonscan.com' },
  80002: { name: 'Polygon Amoy (testes)', rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', explorer: 'https://amoy.polygonscan.com' },
};

export const PAYMENT_METHODS = {
  pix: 'Pix', ted: 'TED', boleto: 'Boleto', transferencia_interna: 'Transferência interna', dinheiro: 'Dinheiro',
};

export const ORG_LABEL = { emissora: 'TokenHub (emissora)', proprietaria: 'Proprietária' };

// status -> [rótulo, tom do badge]
export const STATUS = {
  solicitada: ['Solicitada', 'amber'],
  proposta: ['Aguardando 2ª aprovação', 'amber'],
  emitida: ['Emitida', 'green'],
  tokens_recebidos: ['Tokens recebidos · aguardando pagamento', 'amber'],
  paga: ['Paga · aguardando queima', 'blue'],
  queimada: ['Concluída', 'green'],
  rejeitada: ['Rejeitada', 'red'],
  cancelada: ['Cancelada', 'red'],
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? '').trim());
export const isTx = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s ?? '').trim());
export const shortHex = (s, head = 6, tail = 4) => { const v = String(s ?? ''); return v.length > head + tail + 3 ? v.slice(0, head) + '…' + v.slice(-tail) : v; };

export function fmtBRL(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "1.234,56" | "1234.56" | "1234" | "R$ 1.234" -> centavos (inteiro) ou null se inválido.
export function parseBRL(input) {
  let s = String(input ?? '').replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');   // formato brasileiro
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');  // 1.234 = mil duzentos e trinta e quatro
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int, dec = ''] = s.split('.');
  const cents = Number(int) * 100 + Number((dec + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// Próximo passo de uma ordem para quem está olhando. null = nada a fazer por esta empresa.
export function nextAction(order, org) {
  const { kind, status } = order || {};
  if (kind === 'emissao') {
    if (status === 'solicitada' && org === 'emissora') return { key: 'emitir', label: 'Emitir' };
    if (status === 'proposta' && org === 'proprietaria') return { key: 'aprovar', label: 'Aprovar emissão' };
  }
  if (kind === 'resgate') {
    if (status === 'solicitada' && org === 'emissora') return { key: 'receber', label: 'Confirmar tokens recebidos' };
    if (status === 'tokens_recebidos' && org === 'proprietaria') return { key: 'pagar', label: 'Confirmar pagamento' };
    if (status === 'paga' && org === 'emissora') return { key: 'queimar', label: 'Queimar tokens' };
  }
  return null;
}

// De quem a ordem está esperando, para quem não pode agir.
export function waitingOn(order) {
  const { kind, status } = order || {};
  if (kind === 'emissao' && status === 'solicitada') return 'emissora';
  if (kind === 'emissao' && status === 'proposta') return 'proprietaria';
  if (kind === 'resgate' && (status === 'solicitada' || status === 'paga')) return 'emissora';
  if (kind === 'resgate' && status === 'tokens_recebidos') return 'proprietaria';
  return null;
}

export function canReject(order, org) {
  if (!org) return false;
  const s = order?.status;
  if (s === 'solicitada' || s === 'proposta') return true;
  return s === 'tokens_recebidos' && org === 'emissora';
}

export const isOpen = (order) => !['emitida', 'queimada', 'rejeitada', 'cancelada'].includes(order?.status);

// Emissão direta ou proposta? Mesma regra do contrato: o total descoberto depois da emissão
// não pode passar do limite sem a segunda aprovação.
export function mintPath({ supply, reserve, amount, threshold }) {
  const after = BigInt(supply) + BigInt(amount);
  const uncoveredAfter = after > BigInt(reserve) ? after - BigInt(reserve) : 0n;
  return { path: uncoveredAfter > BigInt(threshold) ? 'propose' : 'mint', uncoveredAfter };
}

// Situação da cobertura a partir do que o contrato informa.
export function coverageState({ supply, reserve, deadline, now }) {
  const uncovered = BigInt(supply) > BigInt(reserve) ? BigInt(supply) - BigInt(reserve) : 0n;
  if (uncovered === 0n) return { uncovered, status: 'coberto', remaining: 0 };
  const remaining = Number(deadline) - Number(now);
  return { uncovered, status: remaining > 0 ? 'no_prazo' : 'vencido', remaining: Math.max(remaining, 0) };
}

export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${m}min`;
}

// Erros do contrato em linguagem de quem opera.
export function contractErrorMessage(name) {
  return ({
    AccessControlUnauthorizedAccount: 'Esta carteira não tem o papel necessário no contrato para esta ação.',
    AccountBlocked: 'Endereço bloqueado no contrato.',
    AccountNotBlocked: 'O endereço precisa estar bloqueado antes desta ação.',
    CoverageOverdue: 'Prazo de cobertura vencido: novas emissões só depois que a proprietária atestar a reserva.',
    DualApprovalRequired: 'O total descoberto passaria do limite: esta emissão precisa ser proposta e aprovada pela proprietária.',
    ReferenceAlreadyUsed: 'Esta ordem já foi executada na rede.',
    MintAlreadyPending: 'Já existe uma proposta pendente para esta ordem.',
    NoPendingMint: 'Não há proposta pendente para esta ordem na rede.',
    SelfApproval: 'Quem propôs não pode aprovar.',
    EnforcedPause: 'O contrato está pausado.',
    ERC20InsufficientBalance: 'Saldo de BRLZX insuficiente na carteira.',
    MintPerTxLimitExceeded: 'Valor acima do teto por emissão definido no contrato. Divida em ordens menores ou peça à proprietária a revisão do teto.',
    DailyMintLimitExceeded: 'Teto de emissão das últimas 24h atingido. Aguarde a janela seguinte ou peça à proprietária a revisão do teto.',
    ZeroAmount: 'Valor zero.',
  })[name] || null;
}

export const ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function paused() view returns (bool)',
  'function attestedReserve() view returns (uint256)',
  'function reserveUpdatedAt() view returns (uint64)',
  'function uncoveredSupply() view returns (uint256)',
  'function coverageDeadline() view returns (uint64)',
  'function coverageWindow() view returns (uint64)',
  'function dualApprovalThreshold() view returns (uint256)',
  'function maxMintPerTx() view returns (uint256)',
  'function mintLimitPerDay() view returns (uint256)',
  'function mintRemainingToday() view returns (uint256)',
  'function isBlocked(address) view returns (bool)',
  'function isMintRefUsed(bytes32) view returns (bool)',
  'function pendingMint(bytes32) view returns (address to, uint256 amount, address proposer)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount, bytes32 ref)',
  'function proposeMint(address to, uint256 amount, bytes32 ref)',
  'function approveMint(bytes32 ref)',
  'function redeem(uint256 amount, bytes32 ref)',
  'function attestReserve(uint256 newReserve)',
  'function blockAccount(address account)',
  'function unblockAccount(address account)',
  'function destroyBlockedFunds(address account)',
  'function pause()',
  'function unpause()',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error AccountBlocked(address account)',
  'error AccountNotBlocked(address account)',
  'error CoverageOverdue(uint256 uncovered, uint64 deadline)',
  'error DualApprovalRequired(uint256 uncoveredAfterMint, uint256 threshold)',
  'error ReferenceAlreadyUsed(bytes32 ref)',
  'error MintAlreadyPending(bytes32 ref)',
  'error NoPendingMint(bytes32 ref)',
  'error SelfApproval()',
  'error MintPerTxLimitExceeded(uint256 amount, uint256 limit)',
  'error DailyMintLimitExceeded(uint256 mintedAfter, uint256 limit)',
  'error EnforcedPause()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ZeroAmount()',
];
