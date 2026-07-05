require("@nomicfoundation/hardhat-toolbox");
require("@fhevm/hardhat-plugin");
require("dotenv").config();

const optimizerSettings = {
  enabled: true,
  runs: 1
};

const compilerSettings = {
  optimizer: optimizerSettings,
  viaIR: true
};

module.exports = {
  solidity: {
    compilers: [
      { version: "0.8.24", settings: compilerSettings },
      { version: "0.8.20", settings: compilerSettings }
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test"
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts: process.env.SEPOLIA_DEPLOYER_KEY ? [process.env.SEPOLIA_DEPLOYER_KEY] : []
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  }
};
