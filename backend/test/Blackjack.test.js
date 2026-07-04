const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { GamePhase, playHandToCompletion, clearSessions } = require("./oracleHelpers");

describe("Blackjack contract", function () {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Blackjack = await ethers.getContractFactory("Blackjack");
    const blackjack = await Blackjack.deploy();
    await blackjack.waitForDeployment();
    clearSessions();
    return { blackjack, owner, alice, bob };
  }

  async function fundedTableFixture() {
    const base = await deployFixture();
    const { blackjack, owner, alice, bob } = base;
    await blackjack.connect(owner).fundBank({ value: ethers.parseEther("1") });
    await blackjack.connect(owner).createTable(1_000, 10_000);
    await blackjack.connect(alice).claimFreeChips();
    await blackjack.connect(bob).claimFreeChips();
    await blackjack.connect(alice).joinTable(1, 5_000);
    await blackjack.connect(bob).joinTable(1, 5_000);
    return base;
  }

  describe("Chip economy", function () {
    it("lets a player claim the promotional chip grant exactly once", async function () {
      const { blackjack, alice } = await loadFixture(deployFixture);
      await expect(blackjack.connect(alice).claimFreeChips())
        .to.emit(blackjack, "FreeChipsClaimed")
        .withArgs(alice.address, 10_000);
      await expect(blackjack.connect(alice).claimFreeChips()).to.be.revertedWith("Already claimed");
    });

    it("mints chips according to the conversion rate and allows withdrawing them", async function () {
      const { blackjack, alice } = await loadFixture(deployFixture);
      const oneEth = ethers.parseEther("1");
      const chips = await blackjack.ethToChips(oneEth);

      await expect(blackjack.connect(alice).buyChips({ value: oneEth }))
        .to.emit(blackjack, "ChipsPurchased")
        .withArgs(alice.address, oneEth, chips);

      await expect(blackjack.connect(alice).withdrawChips(chips))
        .to.emit(blackjack, "ChipsWithdrawn")
        .withArgs(alice.address, chips, oneEth);

      expect(await blackjack.getPlayerChips(alice.address)).to.equal(0);
    });
  });

  describe("Table lifecycle", function () {
    it("allows the owner to create a table and players to join with sufficient chips", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await expect(blackjack.connect(owner).createTable(1_000, 10_000))
        .to.emit(blackjack, "TableCreated")
        .withArgs(1, owner.address);
      expect(await blackjack.getTablesCount()).to.equal(1);

      await blackjack.connect(alice).claimFreeChips();
      await expect(blackjack.connect(alice).joinTable(1, 5_000))
        .to.emit(blackjack, "PlayerJoined")
        .withArgs(1, alice.address, 5_000);

      expect(await blackjack.getPlayerTableId(alice.address)).to.equal(1);
      expect(await blackjack.getPlayerChips(alice.address)).to.equal(5_000);
    });

    it("starts the game automatically once the second player sits down", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(deployFixture);
      await blackjack.connect(owner).createTable(1_000, 10_000);
      await blackjack.connect(alice).claimFreeChips();
      await blackjack.connect(bob).claimFreeChips();
      await blackjack.connect(alice).joinTable(1, 5_000);

      await expect(blackjack.connect(bob).joinTable(1, 5_000))
        .to.emit(blackjack, "GameStarted")
        .withArgs(1);
    });

    it("returns a player's buy-in to their wallet when they leave before the hand starts", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await blackjack.connect(owner).createTable(1_000, 10_000);
      await blackjack.connect(alice).claimFreeChips();
      await blackjack.connect(alice).joinTable(1, 4_000);

      await expect(blackjack.connect(alice).leaveTable(1))
        .to.emit(blackjack, "PlayerLeft")
        .withArgs(1, alice.address);

      expect(await blackjack.getPlayerTableId(alice.address)).to.equal(0);
      expect(await blackjack.getPlayerChips(alice.address)).to.equal(10_000);
    });
  });

  describe("Bank controls", function () {
    it("lets the owner fund and defund the dealer bank while non-owners are blocked", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await expect(blackjack.connect(alice).fundBank({ value: 1 })).to.be.revertedWith("Only owner");

      const deposit = ethers.parseEther("0.5");
      const chipsAdded = await blackjack.ethToChips(deposit);

      await expect(blackjack.connect(owner).fundBank({ value: deposit }))
        .to.emit(blackjack, "BankFunded")
        .withArgs(deposit, chipsAdded);

      await expect(blackjack.connect(owner).defundBank(chipsAdded))
        .to.emit(blackjack, "BankDefunded")
        .withArgs(chipsAdded, deposit);
    });
  });

  describe("Table chip management", function () {
    it("lets seated players top up chips between hands and reclaim them when leaving", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await blackjack.connect(owner).createTable(1_000, 10_000);
      await blackjack.connect(alice).claimFreeChips();
      await blackjack.connect(alice).joinTable(1, 4_000);

      const topUpAmount = 1_000;
      const walletBefore = await blackjack.getPlayerChips(alice.address);

      await expect(blackjack.connect(alice).topUpTableChips(1, topUpAmount))
        .to.emit(blackjack, "TableChipsToppedUp")
        .withArgs(1, alice.address, topUpAmount);

      expect(await blackjack.getPlayerChips(alice.address)).to.equal(walletBefore - BigInt(topUpAmount));

      await expect(blackjack.connect(alice).leaveTable(1))
        .to.emit(blackjack, "PlayerLeft")
        .withArgs(1, alice.address);

      expect(await blackjack.getPlayerChips(alice.address)).to.equal(10_000);
      expect(await blackjack.getPlayerTableId(alice.address)).to.equal(0);
    });

    it("allows players to cash out their stack when no hand is running", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await blackjack.connect(owner).createTable(1_000, 10_000);
      await blackjack.connect(alice).claimFreeChips();
      await blackjack.connect(alice).joinTable(1, 6_000);

      await expect(blackjack.connect(alice).cashOut(1))
        .to.emit(blackjack, "PlayerLeft")
        .withArgs(1, alice.address);

      expect(await blackjack.getPlayerChips(alice.address)).to.equal(10_000);
      expect(await blackjack.getPlayerTableId(alice.address)).to.equal(0);
    });

    it("prevents chip purchases or withdrawals while a player is seated", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await blackjack.connect(owner).createTable(1_000, 10_000);
      await blackjack.connect(alice).claimFreeChips();
      await blackjack.connect(alice).joinTable(1, 4_000);

      await expect(blackjack.connect(alice).buyChips({ value: ethers.parseEther("0.1") }))
        .to.be.revertedWith("Leave table first");

      await expect(blackjack.connect(alice).withdrawChips(1_000))
        .to.be.revertedWith("Leave table first");
    });
  });

  describe("Gameplay integration", function () {
    it("runs a full betting round through oracle deal, stand, and settlement", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(fundedTableFixture);
      const bet = 1_000n;

      await blackjack.connect(alice).placeBet(1, bet);
      await expect(blackjack.connect(bob).placeBet(1, bet))
        .to.emit(blackjack, "OracleActionRequired");

      const table = await playHandToCompletion(blackjack, owner, 1, [alice, bob]);
      expect(table.phase).to.equal(GamePhase.WaitingForPlayers);

      const [, , results, , timestamp] = await blackjack.getLastHandResult(1);
      expect(timestamp).to.be.gt(0);
      expect(results.length).to.equal(2);
    });

    it("stores only encrypted handles in live play state (no plaintext cards)", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(fundedTableFixture);
      await blackjack.connect(alice).placeBet(1, 1_000);
      await blackjack.connect(bob).placeBet(1, 1_000);

      const play = await playHandToCompletion(blackjack, owner, 1, [alice, bob]);
      expect(play.players[0].cardCount).to.equal(0);

      const [rankHandles] = await blackjack.getLastDealerEncryptedHandles(1);
      expect(rankHandles.length).to.be.gt(0);
    });

    it("forfeits an active bet to the bank when leaving mid-hand", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(fundedTableFixture);

      await blackjack.connect(alice).placeBet(1, 1_000);
      await blackjack.connect(bob).placeBet(1, 1_000);

      const { oracleFulfillPending } = require("./oracleHelpers");
      await oracleFulfillPending(blackjack, owner, 1);

      const tableMid = await blackjack.getTablePlayState(1);
      expect(Number(tableMid.phase)).to.equal(GamePhase.PlayerTurns);

      const bankPreLeave = await blackjack.bankChips();
      await blackjack.connect(alice).leaveTable(1);
      expect(await blackjack.bankChips() - bankPreLeave).to.equal(1_000n);
      expect(await blackjack.getPlayerTableId(alice.address)).to.equal(0);

      await playHandToCompletion(blackjack, owner, 1, [bob]);
    });

    it("exposes lightweight table summaries for the lobby", async function () {
      const { blackjack, owner } = await loadFixture(deployFixture);
      await blackjack.connect(owner).createTable(1_000, 10_000);

      const summaries = await blackjack.getAllTableSummaries();
      expect(summaries.length).to.equal(1);
      expect(summaries[0].id).to.equal(1);
      expect(summaries[0].minBuyIn).to.equal(1_000);
      expect(summaries[0].playersSeated).to.equal(0);

      const single = await blackjack.getTableSummary(1);
      expect(single.maxBuyIn).to.equal(10_000);
    });

    it("reports bank solvency against on-chain ETH backing", async function () {
      const { blackjack, owner } = await loadFixture(deployFixture);
      const [floatBefore, ethBackedBefore, solventBefore] = await blackjack.getBankHealth();
      expect(solventBefore).to.equal(ethBackedBefore >= floatBefore);
      expect(floatBefore).to.be.gt(ethBackedBefore);

      const deposit = ethers.parseEther("10");
      await blackjack.connect(owner).fundBank({ value: deposit });

      const [chipsFloat, ethBackedAfter, solventAfter] = await blackjack.getBankHealth();
      const fundedChips = await blackjack.ethToChips(deposit);
      expect(ethBackedAfter).to.equal(ethBackedBefore + fundedChips);
      expect(chipsFloat).to.equal(floatBefore + fundedChips);
      expect(solventAfter).to.equal(chipsFloat <= ethBackedAfter);
    });

    it("marks busted players and blocks further actions", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(fundedTableFixture);
      const { oracleFulfillPending, encryptCards, getSession } = require("./oracleHelpers");

      await blackjack.connect(alice).placeBet(1, 1_000);
      await blackjack.connect(bob).placeBet(1, 1_000);
      await oracleFulfillPending(blackjack, owner, 1);

      const session = getSession(1);
      session.playerHands.set(alice.address.toLowerCase(), [
        { rank: 10, suit: 0, index: 0 },
        { rank: 10, suit: 1, index: 1 }
      ]);

      await blackjack.connect(alice).hit(1);
      const enc = await encryptCards(blackjack, owner, [10], [0]);
      await blackjack.connect(owner).oracleFulfillPending(
        1,
        enc.rankHandles,
        enc.suitHandles,
        enc.inputProof,
        [true],
        [true],
        2,
        false
      );

      const play = await blackjack.getTablePlayState(1);
      const aliceState = play.players.find((p) => p.addr === alice.address);
      expect(aliceState.busted).to.equal(true);
      expect(aliceState.isActive).to.equal(false);
      expect(aliceState.hasActed).to.equal(true);
      expect(await blackjack.isPlayerTurn(1, alice.address)).to.equal(false);
      await expect(blackjack.connect(alice).hit(1)).to.be.revertedWith("Not your turn");
      await expect(blackjack.connect(alice).stand(1)).to.be.revertedWith("Not your turn");
      expect(await blackjack.isPlayerTurn(1, bob.address)).to.equal(true);
    });

    it("settles players who busted (inactive but with bet)", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(fundedTableFixture);
      const { oracleFulfillPending, encryptCards, getSession } = require("./oracleHelpers");

      await blackjack.connect(alice).placeBet(1, 1_000);
      await blackjack.connect(bob).placeBet(1, 1_000);
      await oracleFulfillPending(blackjack, owner, 1);

      const session = getSession(1);
      session.playerHands.set(alice.address.toLowerCase(), [
        { rank: 10, suit: 0, index: 0 },
        { rank: 10, suit: 1, index: 1 }
      ]);

      await blackjack.connect(alice).hit(1);
      const enc = await encryptCards(blackjack, owner, [10], [0]);
      await blackjack.connect(owner).oracleFulfillPending(
        1,
        enc.rankHandles,
        enc.suitHandles,
        enc.inputProof,
        [true],
        [true],
        2,
        false
      );

      await playHandToCompletion(blackjack, owner, 1, [bob]);
      const [, , results] = await blackjack.getLastHandResult(1);
      expect(results.length).to.equal(2);
    });

    it("rejects non-oracle fulfillment", async function () {
      const { blackjack, alice, bob } = await loadFixture(fundedTableFixture);
      await blackjack.connect(alice).placeBet(1, 1_000);
      await blackjack.connect(bob).placeBet(1, 1_000);

      await expect(
        blackjack.connect(alice).oracleDealHand(1, ethers.ZeroHash, 0, [], [], [], '0x')
      ).to.be.revertedWith("Only oracle");
    });
  });

  describe("Admin controls", function () {
    it("blocks gameplay while paused and allows recovery via unpause", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await blackjack.connect(owner).pause();
      await expect(blackjack.connect(alice).claimFreeChips()).to.be.revertedWith("Paused");
      await blackjack.connect(owner).unpause();
      await expect(blackjack.connect(alice).claimFreeChips())
        .to.emit(blackjack, "FreeChipsClaimed")
        .withArgs(alice.address, 10_000);
    });

    it("blocks in-hand actions while paused", async function () {
      const { blackjack, owner, alice, bob } = await loadFixture(fundedTableFixture);
      await blackjack.connect(alice).placeBet(1, 1_000);
      await blackjack.connect(bob).placeBet(1, 1_000);

      const { oracleFulfillPending } = require("./oracleHelpers");
      await oracleFulfillPending(blackjack, owner, 1);

      await blackjack.connect(owner).pause();
      await expect(blackjack.connect(alice).hit(1)).to.be.revertedWith("Paused");
      await expect(blackjack.connect(alice).stand(1)).to.be.revertedWith("Paused");
    });

    it("lets the owner hand off control securely", async function () {
      const { blackjack, owner, alice } = await loadFixture(deployFixture);
      await blackjack.connect(owner).transferOwnership(alice.address);
      await expect(blackjack.connect(owner).pause()).to.be.revertedWith("Only owner");
      await blackjack.connect(alice).pause();
      await blackjack.connect(alice).unpause();
      await blackjack.connect(alice).claimFreeChips();
      expect(await blackjack.getPlayerChips(alice.address)).to.equal(10_000);
    });

    it("enforces the MAX_TABLES limit", async function () {
      const { blackjack, owner } = await loadFixture(deployFixture);
      const maxTables = Number(await blackjack.MAX_TABLES());

      for (let i = 0; i < maxTables; i++) {
        await blackjack.connect(owner).createTable(1_000, 10_000);
      }

      await expect(blackjack.connect(owner).createTable(1_000, 10_000)).to.be.revertedWith("Max tables");
    });
  });
});