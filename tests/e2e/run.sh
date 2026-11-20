#!/usr/bin/env bash
# Roda o teste de ponta a ponta do BRLZX com tudo local: Postgres, nó Hardhat (simulando a Polygon) e o site.
# Requisitos: Postgres local acessível por psql (PGHOST/PGPORT/PGUSER), Node, Python com playwright e um Chrome.
# Uso:  tests/e2e/run.sh      (a partir da raiz do repositório, com `npm install` já feito em blockchain/)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BC="${BLOCKCHAIN_DIR:-$ROOT/blockchain}"
export PGDATABASE=tokenhub_e2e
OWNER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC      # conta 2 do Hardhat: proprietária (admin, reserva, 2ª assinatura)
ISSUER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8     # conta 1 do Hardhat: TokenHub (emite, queima, pausa, bloqueia)

cleanup() { kill "${NODE_PID:-}" "${HTTP_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT

dropdb --if-exists "$PGDATABASE" 2>/dev/null; createdb "$PGDATABASE"
for f in db/tests/supabase-shim.sql db/admin-setup.sql db/brlzx.sql; do psql -q -v ON_ERROR_STOP=1 -f "$ROOT/$f" >/dev/null 2>&1; done

cd "$BC"
HARDHAT_CHAIN_ID=137 npx hardhat node >/tmp/brlzx-node.log 2>&1 & NODE_PID=$!
for _ in $(seq 30); do grep -q "Started HTTP" /tmp/brlzx-node.log 2>/dev/null && break; sleep 1; done
CONTRACT=$(HARDHAT_CHAIN_ID=137 OWNER_ADMIN_ADDRESS=$OWNER OWNER_RESERVE_ADDRESS=$OWNER OWNER_APPROVER_ADDRESS=$OWNER \
  TOKENHUB_MINTER_ADDRESS=$ISSUER TOKENHUB_TREASURY_ADDRESS=$ISSUER TOKENHUB_PAUSER_ADDRESS=$ISSUER TOKENHUB_COMPLIANCE_ADDRESS=$ISSUER \
  npx hardhat run scripts/deploy.js --network localhost | sed -n 's/^Token (proxy): \(0x[0-9a-fA-F]*\).*/\1/p')
[ -n "$CONTRACT" ] || { echo "deploy local falhou"; exit 1; }

cd "$ROOT"
python3 -m http.server 4189 >/dev/null 2>&1 & HTTP_PID=$!
sleep 1
CONTRACT=$CONTRACT ETHERS="$BC/node_modules/ethers" python3 tests/e2e/brlzx_e2e.py
