// Deploy do BRLZX: timelock (admin) + implementação + proxy, já com os papéis separados por empresa.
//
// Proprietária:  OWNER_ADMIN_ADDRESS     multisig que agenda e executa as ações administrativas pelo timelock
//                OWNER_OPS_ADDRESS       retoma o contrato após pausa e também pausa (padrão: OWNER_ADMIN_ADDRESS)
//                OWNER_RESERVE_ADDRESS   atesta a reserva
//                OWNER_APPROVER_ADDRESS  2ª assinatura das emissões descobertas acima do limite
// TokenHub:      TOKENHUB_MINTER_ADDRESS, TOKENHUB_TREASURY_ADDRESS,
//                TOKENHUB_PAUSER_ADDRESS, TOKENHUB_COMPLIANCE_ADDRESS
// Opcional:      ADMIN_TIMELOCK_SECONDS (padrão 172800 = 48h; em testnet use um valor pequeno),
//                TOKEN_NAME, TOKEN_SYMBOL, ADMIN_DELAY_SECONDS
//
// Uso:  npx hardhat run scripts/deploy.js --network polygonAmoy
const { ethers, network } = require("hardhat");

function addr(name, optional = false) {
  const v = process.env[name];
  if (!v && optional) return ethers.ZeroAddress;
  if (!ethers.isAddress(v)) throw new Error(`Defina ${name} com um endereço válido`);
  return v;
}

async function main() {
  const name = process.env.TOKEN_NAME || "BRLZX";
  const symbol = process.env.TOKEN_SYMBOL || "BRLZX";
  const adminDelay = Number(process.env.ADMIN_DELAY_SECONDS || 2 * 24 * 60 * 60);
  const ownerMultisig = addr("OWNER_ADMIN_ADDRESS");
  const timelockDelay = Number(process.env.ADMIN_TIMELOCK_SECONDS || 48 * 60 * 60);
  const roles = {
    minter: addr("TOKENHUB_MINTER_ADDRESS"),
    burner: addr("TOKENHUB_TREASURY_ADDRESS"),
    pauser: addr("TOKENHUB_PAUSER_ADDRESS"),
    compliance: addr("TOKENHUB_COMPLIANCE_ADDRESS"),
    reserve: addr("OWNER_RESERVE_ADDRESS"),
    approver: addr("OWNER_APPROVER_ADDRESS"),
    unpauser: process.env.OWNER_OPS_ADDRESS ? addr("OWNER_OPS_ADDRESS") : ownerMultisig,
  };

  const [deployer] = await ethers.getSigners();
  console.log(`Rede: ${network.name} | deployer: ${deployer.address}`);

  // O admin do token é o timelock; só o multisig da proprietária agenda e executa por ele.
  const Timelock = await ethers.getContractFactory("StablecoinTimelock");
  const timelock = await Timelock.deploy(timelockDelay, [ownerMultisig], [ownerMultisig]);
  await timelock.waitForDeployment();
  const admin = await timelock.getAddress();

  const Impl = await ethers.getContractFactory("StablecoinBRL");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();

  const init = Impl.interface.encodeFunctionData("initialize", [name, symbol, admin, adminDelay, roles]);
  const Proxy = await ethers.getContractFactory("StablecoinProxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), init);
  await proxy.waitForDeployment();

  const token = Impl.attach(await proxy.getAddress());
  console.log("Implementação:", await impl.getAddress());
  console.log("Token (proxy):", await token.getAddress(), "<- este é o endereço da stablecoin");
  console.log(`Nome: ${await token.name()} | símbolo: ${await token.symbol()}`);
  console.log("Admin do token (timelock):", await token.defaultAdmin(), `| atraso: ${timelockDelay / 3600}h`);
  console.log("Multisig da proprietária (agenda e executa pelo timelock):", ownerMultisig);
  console.table(roles);
  console.log("O deployer não fica com nenhum papel. Próximo passo: a proprietária atesta a reserva.");
}

main().catch((e) => { console.error(e); process.exit(1); });
