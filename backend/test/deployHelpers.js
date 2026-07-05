const { ethers } = require("hardhat");

async function deployBlackjack() {
  const mathLib = await ethers.getContractFactory("BlackjackMathLib");
  const mathLibInstance = await mathLib.deploy();
  await mathLibInstance.waitForDeployment();
  const mathLibAddress = await mathLibInstance.getAddress();

  const Blackjack = await ethers.getContractFactory("Blackjack", {
    libraries: {
      BlackjackMathLib: mathLibAddress
    }
  });
  const blackjack = await Blackjack.deploy();
  await blackjack.waitForDeployment();
  return { blackjack, mathLibAddress };
}

module.exports = { deployBlackjack };