import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  centsToUnits, unitsToCents, parseBRL, fmtBRL, nextAction, waitingOn, canReject, isOpen,
  mintPath, coverageState, fmtCountdown, esc, isAddress, isTx, shortHex, contractErrorMessage, ABI, STATUS,
} from './brlzx-core.js';

// unidades
assert.equal(centsToUnits(1), 10000n);
assert.equal(centsToUnits(10_000_000), 100_000_000_000n);      // R$ 100 mil = 100.000 * 10^6
assert.equal(unitsToCents(100_000_000_000n), 10_000_000);
assert.equal(unitsToCents(19_999n), 1);                         // arredonda para baixo

// valores digitados
assert.equal(parseBRL('1.234,56'), 123456);
assert.equal(parseBRL('1234.56'), 123456);
assert.equal(parseBRL('1234'), 123400);
assert.equal(parseBRL('R$ 1.234'), 123400);
assert.equal(parseBRL('100.000'), 10000000);
assert.equal(parseBRL('0,5'), 50);
assert.equal(parseBRL('10,5'), 1050);
for (const bad of ['', 'abc', '0', '-5', '1,234', '1.2.3', '12,345', '1e5']) assert.equal(parseBRL(bad), null, bad);
assert.match(fmtBRL(123456), /1\.234,56/);

// quem faz o quê
const em = (status) => ({ kind: 'emissao', status }), rs = (status) => ({ kind: 'resgate', status });
assert.equal(nextAction(em('solicitada'), 'emissora').key, 'emitir');
assert.equal(nextAction(em('solicitada'), 'proprietaria'), null);
assert.equal(nextAction(em('proposta'), 'proprietaria').key, 'aprovar');
assert.equal(nextAction(em('proposta'), 'emissora'), null);       // quem propõe não aprova
assert.equal(nextAction(em('emitida'), 'emissora'), null);
assert.equal(nextAction(rs('solicitada'), 'emissora').key, 'receber');
assert.equal(nextAction(rs('tokens_recebidos'), 'proprietaria').key, 'pagar');
assert.equal(nextAction(rs('tokens_recebidos'), 'emissora'), null); // emissora não paga
assert.equal(nextAction(rs('paga'), 'emissora').key, 'queimar');
assert.equal(nextAction(rs('paga'), 'proprietaria'), null);        // proprietária não queima
assert.equal(nextAction(rs('solicitada'), null), null);            // cliente não age
assert.equal(waitingOn(em('proposta')), 'proprietaria');
assert.equal(waitingOn(rs('paga')), 'emissora');
assert.equal(waitingOn(rs('queimada')), null);
assert.equal(canReject(em('solicitada'), 'proprietaria'), true);
assert.equal(canReject(rs('tokens_recebidos'), 'proprietaria'), false);
assert.equal(canReject(rs('tokens_recebidos'), 'emissora'), true);
assert.equal(canReject(rs('paga'), 'emissora'), false);
assert.equal(canReject(em('solicitada'), null), false);
assert.equal(isOpen(em('proposta')), true);
assert.equal(isOpen(em('emitida')), false);
for (const s of ['solicitada', 'proposta', 'emitida', 'tokens_recebidos', 'paga', 'queimada', 'rejeitada', 'cancelada']) assert.ok(STATUS[s], s);

// emissão direta x proposta: mesma regra do contrato (total descoberto acumulado)
const U = (reais) => centsToUnits(reais * 100);
assert.equal(mintPath({ supply: 0n, reserve: U(5_000_000), amount: U(5_000_000), threshold: U(100_000) }).path, 'mint');   // coberta
assert.equal(mintPath({ supply: 0n, reserve: U(900_000), amount: U(1_000_000), threshold: U(100_000) }).path, 'mint');     // 100 mil descobertos: no limite
assert.equal(mintPath({ supply: 0n, reserve: U(900_000), amount: U(1_000_000) + 1n, threshold: U(100_000) }).path, 'propose');
assert.equal(mintPath({ supply: U(61_000), reserve: U(1_000), amount: U(50_000), threshold: U(100_000) }).path, 'propose'); // fracionada: 60 + 50
assert.equal(mintPath({ supply: U(61_000), reserve: U(1_000), amount: U(40_000), threshold: U(100_000) }).path, 'mint');
assert.equal(mintPath({ supply: U(61_000), reserve: U(1_000), amount: U(50_000), threshold: U(100_000) }).uncoveredAfter, U(110_000));

// cobertura
assert.deepEqual(coverageState({ supply: 10n, reserve: 10n, deadline: 0, now: 1000 }), { uncovered: 0n, status: 'coberto', remaining: 0 });
assert.equal(coverageState({ supply: 15n, reserve: 10n, deadline: 5000, now: 1000 }).status, 'no_prazo');
assert.equal(coverageState({ supply: 15n, reserve: 10n, deadline: 5000, now: 1000 }).remaining, 4000);
assert.equal(coverageState({ supply: 15n, reserve: 10n, deadline: 5000, now: 5000 }).status, 'vencido');
assert.equal(coverageState({ supply: 15n, reserve: 10n, deadline: 5000, now: 9000 }).uncovered, 5n);
assert.equal(fmtCountdown(48 * 3600), '48h 00min');
assert.equal(fmtCountdown(3725), '1h 02min');
assert.equal(fmtCountdown(59), '0min');
assert.equal(fmtCountdown(-5), '0min');

// escapes e formatos
assert.equal(esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
assert.equal(esc(null), '');
assert.equal(isAddress('0x' + 'a'.repeat(40)), true);
assert.equal(isAddress('0x' + 'a'.repeat(39)), false);
assert.equal(isTx('0x' + 'f'.repeat(64)), true);
assert.equal(isTx('0x' + 'g'.repeat(64)), false);
assert.equal(shortHex('0x1234567890abcdef'), '0x1234…cdef');
assert.equal(contractErrorMessage('SelfApproval'), 'Quem propôs não pode aprovar.');
assert.equal(contractErrorMessage('Desconhecido'), null);

// O ABI usado nas telas tem de existir no contrato compilável.
const sol = readFileSync(new URL('./blockchain/contracts/StablecoinBRL.sol', import.meta.url), 'utf8');
const own = ['mint', 'proposeMint', 'approveMint', 'redeem', 'attestReserve', 'blockAccount', 'unblockAccount',
  'destroyBlockedFunds', 'pause', 'unpause', 'attestedReserve', 'reserveUpdatedAt', 'uncoveredSupply',
  'coverageDeadline', 'coverageWindow', 'dualApprovalThreshold', 'isBlocked', 'isMintRefUsed', 'pendingMint'];
for (const fn of own) {
  assert.ok(ABI.some((l) => l.startsWith(`function ${fn}(`)), `ABI sem ${fn}`);
  assert.ok(new RegExp(`function ${fn}\\(`).test(sol), `contrato sem ${fn}`);
}
for (const e of ['AccountBlocked', 'CoverageOverdue', 'DualApprovalRequired', 'ReferenceAlreadyUsed', 'MintAlreadyPending', 'NoPendingMint', 'SelfApproval', 'ZeroAmount']) {
  assert.ok(new RegExp(`error ${e}\\(`).test(sol), `contrato sem o erro ${e}`);
}

console.log('brlzx-core: ok');
