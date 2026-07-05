const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function deployBlackjack() {
  const mathLib = await hre.ethers.getContractFactory("BlackjackMathLib");
  const mathLibInstance = await mathLib.deploy();
  await mathLibInstance.waitForDeployment();
  const mathLibAddress = await mathLibInstance.getAddress();
  console.log("BlackjackMathLib deployed to:", mathLibAddress);

  const Blackjack = await hre.ethers.getContractFactory("Blackjack", {
    libraries: {
      BlackjackMathLib: mathLibAddress
    }
  });
  const blackjack = await Blackjack.deploy();
  await blackjack.waitForDeployment();
  return { blackjack, mathLibAddress };
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const { blackjack, mathLibAddress } = await deployBlackjack();

  const address = await blackjack.getAddress();
  console.log("Blackjack deployed to:", address);

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const deploymentPath = path.join(deploymentsDir, `${hre.network.name}.json`);

  const bankFundEth = process.env.BANK_FUND_ETH ?? "0.05";
  let bankFunded = false;
  if (Number(bankFundEth) > 0) {
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    const fundWei = hre.ethers.parseEther(bankFundEth);
    const gasBuffer = hre.ethers.parseEther("0.01");
    if (balance < fundWei + gasBuffer) {
      console.warn(
        `Skipping fundBank: deployer balance ${hre.ethers.formatEther(balance)} ETH ` +
        `is below requested ${bankFundEth} ETH + gas buffer. Fund the bank manually later.`
      );
    } else {
      const tx = await blackjack.fundBank({ value: fundWei });
      await tx.wait();
      bankFunded = true;
      const [chipsFloat, ethBackedChips, solvent] = await blackjack.getBankHealth();
      console.log(`Bank funded with ${bankFundEth} ETH`);
      console.log(`Bank health — float: ${chipsFloat}, ETH-backed: ${ethBackedChips}, solvent: ${solvent}`);
    }
  }

  fs.writeFileSync(
    deploymentPath,
    JSON.stringify(
      {
        network: hre.network.name,
        contract: "Blackjack",
        address,
        mathLib: mathLibAddress,
        deployer: deployer.address,
        bankFundEth: bankFunded ? bankFundEth : "0",
        deployedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
  console.log("Deployment metadata written to:", deploymentPath);
  console.log(`Set VITE_BLACKJACK_CONTRACT=${address} in frontend/.env`);
  console.log(`Set BLACKJACK_CONTRACT_ADDRESS=${address} in backend/.env`);
  console.log(`Deployer ${deployer.address} is gameOracle by default. For a dedicated oracle key:`);
  console.log("  1. blackjack.setGameOracle(oracleSignerAddress)");
  console.log("  2. ORACLE_PRIVATE_KEY=<oracle key> && npm run oracle");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { deployBlackjack };