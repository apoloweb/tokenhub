// Destrava a conta de deploy quando há transação presa na fila da rede.
//
// Na Polygon, uma transação enviada com taxa baixa pode ficar pendente para sempre, e todas as
// seguintes da mesma conta esperam atrás dela. Este script substitui cada transação pendente por um
// envio de valor zero para a própria conta, com taxa alta. Depois dele, rode o deploy de novo.
//
// Uso:  STUCK_TX=0x<hash da transação parada> npx hardhat run scripts/limpar-fila.js --network polygonAmoy
const { ethers, network } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  const p = ethers.provider;
  const addr = signer.address;

  const block = await p.getBlock("latest");
  const age = Math.round(Date.now() / 1000 - block.timestamp);
  console.log(`Rede: ${network.name} | conta: ${addr}`);
  console.log(`Último bloco: ${block.number}, há ${age}s | taxa base: ${ethers.formatUnits(block.baseFeePerGas ?? 0n, "gwei")} gwei`);
  if (age > 120) console.log("Atenção: a rede está sem produzir blocos há mais de 2 minutos. O problema pode ser da própria rede de teste.");

  const latest = await p.getTransactionCount(addr, "latest");
  const pending = await p.getTransactionCount(addr, "pending");
  let last = pending - 1;
  if (process.env.STUCK_TX) {
    const tx = await p.getTransaction(process.env.STUCK_TX);
    if (tx) {
      console.log(`Transação informada: nonce ${tx.nonce}, gorjeta ${ethers.formatUnits(tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n, "gwei")} gwei, ${tx.blockNumber ? "confirmada no bloco " + tx.blockNumber : "pendente"}`);
      if (!tx.blockNumber && tx.nonce > last) last = tx.nonce;
    } else {
      console.log("Transação informada: este servidor não a conhece.");
    }
  }
  console.log(`Transações confirmadas da conta: ${latest} | próxima livre segundo a fila: ${pending}`);
  if (last < latest) {
    console.log("Nada preso na fila desta conta. Pode rodar o deploy.");
    return;
  }
  console.log(`Presas na fila: da posição ${latest} à ${last} (${last - latest + 1} transação(ões)). Substituindo...`);

  const tip = ethers.parseUnits(process.env.UNSTICK_PRIORITY_GWEI || "60", "gwei");
  const base2 = (block.baseFeePerGas ?? 0n) * 2n + tip;
  const floor = ethers.parseUnits("200", "gwei");
  const maxFee = base2 > floor ? base2 : floor;

  const sent = [];
  for (let nonce = latest; nonce <= last; nonce++) {
    try {
      const tx = await signer.sendTransaction({ to: addr, value: 0n, nonce, gasLimit: 21000n, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee });
      console.log(`  posição ${nonce}: substituta enviada ${tx.hash}`);
      sent.push(tx);
    } catch (e) {
      console.log(`  posição ${nonce}: não foi possível substituir — ${e.shortMessage || e.message}`);
    }
  }
  for (const tx of sent) {
    try {
      await Promise.race([tx.wait(1), new Promise((_, no) => setTimeout(() => no(new Error("tempo esgotado")), 180000))]);
      console.log(`  ${tx.hash}: confirmada`);
    } catch (e) {
      console.log(`  ${tx.hash}: sem confirmação (${e.shortMessage || e.message})`);
    }
  }
  const after = await p.getTransactionCount(addr, "latest");
  console.log(`Transações confirmadas da conta agora: ${after}. ${after > last ? "Fila limpa. Pode rodar o deploy." : "Ainda há transação presa; me mande esta saída."}`);
  console.log(`Saldo: ${ethers.formatEther(await p.getBalance(addr))} POL`);
}

main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
