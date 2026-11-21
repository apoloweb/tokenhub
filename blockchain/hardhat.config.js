require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Opcional: defina USE_LOCAL_SOLC=1 para compilar com o solc instalado via npm
// (útil em ambientes sem acesso a binaries.soliditylang.org).
if (process.env.USE_LOCAL_SOLC === "1") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args) => {
    const solc = require("solc");
    return {
      compilerPath: path.join(path.dirname(require.resolve("solc/package.json")), "soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solc.version(),
    };
  });
}

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    // Rede local. HARDHAT_CHAIN_ID=137 simula a Polygon nos testes de ponta a ponta das telas.
    hardhat: { chainId: Number(process.env.HARDHAT_CHAIN_ID || 31337) },
    // Testnets — só para homologação. Mainnet deve ser assinada por multisig/hardware wallet.
    polygon: { url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com", accounts },
    polygonAmoy: { url: process.env.AMOY_RPC_URL || "https://polygon-amoy-bor-rpc.publicnode.com", accounts },
  },
};
