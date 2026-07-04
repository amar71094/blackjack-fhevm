// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * CipherJack — FHE-first blackjack.
 * - Live hands store ONLY encrypted rank/suit handles (no plaintext Card[] on-chain).
 * - Deck is committed off-chain (deckCommitment hash only); dealing uses relayer encrypted inputs (no plaintext cards in calldata).
 * - Players submit intents (hit/stand/...); oracle fulfills via fulfillPendingAction.
 * - Showdown uses FHE.makePubliclyDecryptable for dealer reveal + outcome totals (no card history on-chain).
 */

import { FHE, euint8, externalEuint8 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract Blackjack is ZamaEthereumConfig {
    enum TableStatus { Waiting, Active, Closed }
    enum GamePhase { WaitingForPlayers, Dealing, PlayerTurns, DealerTurn, Showdown, Completed }
    enum Outcome { Lose, Win, Push, Blackjack }
    enum PendingKind { None, DealHand, Hit, Stand, DoubleDown, DealerPlay, Settle }

    struct Player {
        address addr;
        uint chips;
        uint bet;
        uint8 cardCount;
        euint8[] encRanks;
        euint8[] encSuits;
        bool isActive;
        bool hasActed;
        bool busted;
    }

    struct Dealer {
        uint8 cardCount;
        euint8[] encRanks;
        euint8[] encSuits;
        bool hasFinished;
    }

    struct PlayerResult {
        address addr;
        uint bet;
        uint total;
        Outcome outcome;
        uint payout;
    }

    struct HandResult {
        uint dealerTotal;
        bool dealerBusted;
        PlayerResult[] results;
        uint pot;
        uint timestamp;
        euint8[] dealerEncRanks;
        euint8[] dealerEncSuits;
    }

    struct Table {
        uint id;
        TableStatus status;
        uint minBuyIn;
        uint maxBuyIn;
        bytes32 deckCommitment;
        uint8 deckIndex;
        GamePhase phase;
        Player[] players;
        Dealer dealer;
        uint lastActivityTimestamp;
        HandResult lastHandResult;
        bool hasPendingResult;
        uint nextHandUnlockTime;
        PendingKind pendingKind;
        address pendingPlayer;
    }

    struct TableSummary {
        uint id;
        TableStatus status;
        uint minBuyIn;
        uint maxBuyIn;
        GamePhase phase;
        uint8 playersSeated;
        uint pot;
    }

    struct PlayPlayer {
        address addr;
        uint chips;
        uint bet;
        uint8 cardCount;
        bool isActive;
        bool hasActed;
        bool busted;
    }

    struct PlayDealer {
        uint8 cardCount;
        bool hasFinished;
    }

    struct PlayTable {
        uint id;
        TableStatus status;
        uint minBuyIn;
        uint maxBuyIn;
        bytes32 deckCommitment;
        uint8 deckIndex;
        GamePhase phase;
        PlayPlayer[] players;
        PlayDealer dealer;
        uint lastActivityTimestamp;
        PendingKind pendingKind;
        address pendingPlayer;
    }

    Table[] public tables;
    uint public constant MAX_TABLES = 100;
    uint public constant MAX_PLAYERS = 4;
    uint public constant TURN_TIMEOUT = 60 seconds;
    uint public constant BLACKJACK_PAYOUT_NUM = 3;
    uint public constant BLACKJACK_PAYOUT_DEN = 2;
    uint public constant CHIPS_PER_ETH = 100_000_000;
    uint public constant WEI_PER_CHIP = 1e18 / CHIPS_PER_ETH;

    mapping(address => uint) public playerTableId;
    mapping(address => bool) public hasClaimedFreeChips;
    mapping(address => uint) public playerChips;
    uint public bankChips;

    bool private _locked;
    address public owner;
    address public gameOracle;
    bool public paused;

    event TableCreated(uint indexed tableId, address indexed creator);
    event PlayerJoined(uint indexed tableId, address indexed player, uint amount);
    event PlayerLeft(uint indexed tableId, address indexed player);
    event GameStarted(uint indexed tableId);
    event HandStarted(uint indexed tableId);
    event PlayerAction(uint indexed tableId, address indexed player, string action, uint amount);
    event DealerAction(uint indexed tableId, string action);
    event WinnerDetermined(uint indexed tableId, address[] winners, uint[] amounts);
    event PayoutSent(uint indexed tableId, address indexed player, uint amount);
    event PhaseChanged(uint indexed tableId, GamePhase newPhase);
    event EncryptedCardDealt(uint indexed tableId, address indexed player, bytes32 rankHandle, bytes32 suitHandle);
    event PlayerBusted(uint indexed tableId, address indexed player);
    event PlayerStood(uint indexed tableId, address indexed player);
    event BetPlaced(uint indexed tableId, address indexed player, uint amount);
    event FreeChipsClaimed(address indexed player, uint amount);
    event ChipsPurchased(address indexed player, uint weiAmount, uint chipAmount);
    event ChipsWithdrawn(address indexed player, uint chipAmount, uint weiAmount);
    event TurnAutoAdvanced(uint indexed tableId, address indexed playerTimedOut, string reason);
    event TableChipsToppedUp(uint indexed tableId, address indexed player, uint amount);
    event BankFunded(uint weiAmount, uint chipsAdded);
    event BankDefunded(uint chipsWithdrawn, uint weiAmount);
    event HandResultStored(uint indexed tableId, uint timestamp);
    event OracleActionRequired(uint indexed tableId, PendingKind kind, address indexed player);
    event DeckCommitted(uint indexed tableId, bytes32 deckCommitment);
    event GameOracleUpdated(address indexed previousOracle, address indexed newOracle);

    modifier nonReentrant() { require(!_locked, "ReentrancyGuard"); _locked = true; _; _locked = false; }
    modifier whenNotPaused() { require(!paused, "Paused"); _; }
    modifier onlyOwner() { require(msg.sender == owner, "Only owner"); _; }
    modifier onlyOracle() { require(msg.sender == gameOracle, "Only oracle"); _; }

    modifier atActiveTable(uint tableId) {
        require(tableId > 0 && tableId <= tables.length, "Table DNE");
        require(playerTableId[msg.sender] == tableId, "Not at this table");
        _;
    }

    modifier isMyTurn(uint tableId) {
        Table storage t = _getTable(tableId);
        require(t.status == TableStatus.Active, "Inactive");
        require(t.phase == GamePhase.PlayerTurns, "Not player phase");
        require(t.pendingKind == PendingKind.None, "Oracle pending");
        require(_isMyTurnInternal(tableId, msg.sender), "Not your turn");
        _;
    }

    constructor() {
        owner = msg.sender;
        gameOracle = msg.sender;
        bankChips = 1_000_000_000;
    }

    function setGameOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Zero addr");
        emit GameOracleUpdated(gameOracle, newOracle);
        gameOracle = newOracle;
    }

    // ========= Views =========

    /// @notice Privacy-safe table state for gameplay UI (no card values, no deck).
    function getTablePlayState(uint tableId) external view returns (PlayTable memory) {
        Table storage t = _getTable(tableId);
        PlayPlayer[] memory players = new PlayPlayer[](t.players.length);
        for (uint i = 0; i < t.players.length; i++) {
            players[i] = PlayPlayer({
                addr: t.players[i].addr,
                chips: t.players[i].chips,
                bet: t.players[i].bet,
                cardCount: t.players[i].cardCount,
                isActive: t.players[i].isActive,
                hasActed: t.players[i].hasActed,
                busted: t.players[i].busted
            });
        }
        return PlayTable({
            id: t.id,
            status: t.status,
            minBuyIn: t.minBuyIn,
            maxBuyIn: t.maxBuyIn,
            deckCommitment: t.deckCommitment,
            deckIndex: t.deckIndex,
            phase: t.phase,
            players: players,
            dealer: PlayDealer({ cardCount: t.dealer.cardCount, hasFinished: t.dealer.hasFinished }),
            lastActivityTimestamp: t.lastActivityTimestamp,
            pendingKind: t.pendingKind,
            pendingPlayer: t.pendingPlayer
        });
    }

    function getTableSummary(uint tableId) external view returns (TableSummary memory) {
        return _buildTableSummary(_getTable(tableId));
    }

    function getAllTableSummaries() external view returns (TableSummary[] memory) {
        uint len = tables.length;
        TableSummary[] memory summaries = new TableSummary[](len);
        for (uint i = 0; i < len; i++) summaries[i] = _buildTableSummary(tables[i]);
        return summaries;
    }

    function getTablesCount() external view returns (uint) { return tables.length; }
    function getPlayerTableId(address player) external view returns (uint) { return playerTableId[player]; }

    function getBankHealth() external view returns (uint chipsFloat, uint ethBackedChips, bool solvent) {
        chipsFloat = bankChips;
        ethBackedChips = ethToChips(address(this).balance);
        solvent = bankChips <= ethBackedChips;
    }

    function isPlayerTurn(uint tableId, address player) external view returns (bool) {
        if (tableId == 0 || tableId > tables.length) return false;
        if (playerTableId[player] != tableId) return false;
        Table storage t = tables[tableId - 1];
        if (t.status != TableStatus.Active || t.phase != GamePhase.PlayerTurns) return false;
        if (t.pendingKind != PendingKind.None) return false;
        return _isMyTurnInternal(tableId, player);
    }

    function getConversionRates() external pure returns (uint chipsPerEth, uint weiPerChip) {
        return (CHIPS_PER_ETH, WEI_PER_CHIP);
    }

    /// @notice Pure helper so off-chain oracle can verify deck commitments match on-chain encoding.
    function deckCommitmentOf(uint8[] calldata deckOrder) external pure returns (bytes32) {
        return _deckCommitment(deckOrder);
    }

    function ethToChips(uint weiAmount) public pure returns (uint) { return weiAmount / WEI_PER_CHIP; }
    function chipsToWei(uint chipAmount) public pure returns (uint) { return chipAmount * WEI_PER_CHIP; }
    function getNextPlayer(uint tableId) external view returns (address) { return _nextPlayerAddr(tableId); }

    function getLastDealerEncryptedHandles(uint tableId)
        external view returns (bytes32[] memory rankHandles, bytes32[] memory suitHandles)
    {
        Table storage t = _getTable(tableId);
        euint8[] storage r = t.lastHandResult.dealerEncRanks;
        euint8[] storage s = t.lastHandResult.dealerEncSuits;
        rankHandles = new bytes32[](r.length);
        suitHandles = new bytes32[](s.length);
        for (uint i = 0; i < r.length; i++) rankHandles[i] = FHE.toBytes32(r[i]);
        for (uint j = 0; j < s.length; j++) suitHandles[j] = FHE.toBytes32(s[j]);
    }

    function getPlayerEncryptedHandles(uint tableId, address player)
        external view returns (bytes32[] memory rankHandles, bytes32[] memory suitHandles)
    {
        Table storage t = _getTable(tableId);
        uint idx = _getPlayerIndex(tableId, player);
        euint8[] storage r = t.players[idx].encRanks;
        euint8[] storage s = t.players[idx].encSuits;
        rankHandles = new bytes32[](r.length);
        suitHandles = new bytes32[](s.length);
        for (uint i = 0; i < r.length; i++) rankHandles[i] = FHE.toBytes32(r[i]);
        for (uint j = 0; j < s.length; j++) suitHandles[j] = FHE.toBytes32(s[j]);
    }

    function getDealerEncryptedHandles(uint tableId)
        external view returns (bytes32[] memory rankHandles, bytes32[] memory suitHandles)
    {
        Table storage t = _getTable(tableId);
        euint8[] storage r = t.dealer.encRanks;
        euint8[] storage s = t.dealer.encSuits;
        rankHandles = new bytes32[](r.length);
        suitHandles = new bytes32[](s.length);
        for (uint i = 0; i < r.length; i++) rankHandles[i] = FHE.toBytes32(r[i]);
        for (uint j = 0; j < s.length; j++) suitHandles[j] = FHE.toBytes32(s[j]);
    }

    function getLastHandResult(uint tableId)
        external view returns (uint dealerTotal, bool dealerBusted, PlayerResult[] memory results, uint pot, uint timestamp)
    {
        Table storage t = _getTable(tableId);
        HandResult storage hr = t.lastHandResult;
        return (hr.dealerTotal, hr.dealerBusted, hr.results, hr.pot, hr.timestamp);
    }

    // ========= Economy (unchanged) =========

    function claimFreeChips() external whenNotPaused {
        require(!hasClaimedFreeChips[msg.sender], "Already claimed");
        require(playerTableId[msg.sender] == 0, "Leave table first");
        hasClaimedFreeChips[msg.sender] = true;
        playerChips[msg.sender] += 10_000;
        emit FreeChipsClaimed(msg.sender, 10_000);
    }

    function buyChips() external payable whenNotPaused nonReentrant {
        require(msg.value > 0, "Send ETH");
        require(playerTableId[msg.sender] == 0, "Leave table first");
        uint chips = ethToChips(msg.value);
        require(chips > 0, "Amount too small");
        playerChips[msg.sender] += chips;
        emit ChipsPurchased(msg.sender, msg.value, chips);
    }

    function withdrawChips(uint chipAmount) external whenNotPaused nonReentrant {
        require(chipAmount > 0, "Zero");
        require(playerChips[msg.sender] >= chipAmount, "Insufficient chips");
        require(playerTableId[msg.sender] == 0, "Leave table first");
        uint weiAmount = chipsToWei(chipAmount);
        require(address(this).balance >= weiAmount, "Contract lacks ETH");
        playerChips[msg.sender] -= chipAmount;
        (bool ok,) = payable(msg.sender).call{value: weiAmount}("");
        require(ok, "ETH transfer failed");
        emit ChipsWithdrawn(msg.sender, chipAmount, weiAmount);
    }

    function getPlayerChips(address player) external view returns (uint) { return playerChips[player]; }

    function topUpTableChips(uint tableId, uint amount) external whenNotPaused atActiveTable(tableId) {
        Table storage t = _getTable(tableId);
        require(t.phase == GamePhase.WaitingForPlayers, "Only between hands");
        require(t.pendingKind == PendingKind.None, "Oracle pending");
        require(playerChips[msg.sender] >= amount, "Insufficient wallet chips");
        uint idx = _getPlayerIndex(tableId, msg.sender);
        playerChips[msg.sender] -= amount;
        t.players[idx].chips += amount;
        t.lastActivityTimestamp = block.timestamp;
        emit TableChipsToppedUp(tableId, msg.sender, amount);
    }

    function fundBank() external payable onlyOwner {
        require(msg.value > 0, "No ETH sent");
        bankChips += ethToChips(msg.value);
        emit BankFunded(msg.value, ethToChips(msg.value));
    }

    function defundBank(uint chipAmount) external onlyOwner nonReentrant {
        require(chipAmount > 0 && chipAmount <= bankChips, "Invalid amount");
        uint weiAmount = chipsToWei(chipAmount);
        require(address(this).balance >= weiAmount, "Contract lacks ETH");
        bankChips -= chipAmount;
        (bool ok,) = payable(msg.sender).call{value: weiAmount}("");
        require(ok, "ETH transfer failed");
        emit BankDefunded(chipAmount, weiAmount);
    }

    // ========= Table lifecycle =========

    function createTable(uint _minBuyIn, uint _maxBuyIn) external whenNotPaused {
        require(tables.length < MAX_TABLES, "Max tables");
        require(_minBuyIn > 0 && _maxBuyIn >= _minBuyIn, "Invalid stakes");
        tables.push();
        uint tableId = tables.length;
        Table storage t = tables[tableId - 1];
        t.id = tableId;
        t.status = TableStatus.Waiting;
        t.minBuyIn = _minBuyIn;
        t.maxBuyIn = _maxBuyIn;
        t.phase = GamePhase.WaitingForPlayers;
        t.lastActivityTimestamp = block.timestamp;
        emit TableCreated(tableId, msg.sender);
    }

    function joinTable(uint tableId, uint buyInAmount) external whenNotPaused {
        Table storage t = _getTable(tableId);
        require(t.players.length < MAX_PLAYERS, "Table full");
        require(playerTableId[msg.sender] == 0, "Already at table");
        require(buyInAmount >= t.minBuyIn && buyInAmount <= t.maxBuyIn, "Invalid buy-in");
        require(playerChips[msg.sender] >= buyInAmount, "Insufficient chips");
        playerChips[msg.sender] -= buyInAmount;
        t.players.push();
        Player storage p = t.players[t.players.length - 1];
        p.addr = msg.sender;
        p.chips = buyInAmount;
        p.isActive = false;
        p.hasActed = true;
        playerTableId[msg.sender] = tableId;
        t.lastActivityTimestamp = block.timestamp;
        emit PlayerJoined(tableId, msg.sender, buyInAmount);
        if (t.players.length >= 2 && t.status == TableStatus.Waiting) {
            t.status = TableStatus.Active;
            emit GameStarted(tableId);
        }
    }

    function leaveTable(uint tableId) external whenNotPaused atActiveTable(tableId) {
        Table storage t = _getTable(tableId);
        require(t.pendingKind == PendingKind.None || t.pendingPlayer == msg.sender, "Oracle pending");
        uint idx = _getPlayerIndex(tableId, msg.sender);
        Player storage p = t.players[idx];
        GamePhase phaseBeforeLeave = t.phase;

        if (t.phase != GamePhase.WaitingForPlayers) {
            if (p.bet > 0) { bankChips += p.bet; p.bet = 0; }
            playerChips[msg.sender] += p.chips;
            p.chips = 0;
            p.isActive = false;
            p.hasActed = true;
            playerTableId[msg.sender] = 0;
            for (uint i = idx; i < t.players.length - 1; i++) t.players[i] = t.players[i + 1];
            t.players.pop();
            emit PlayerLeft(tableId, msg.sender);
            _clearPending(t);
            if (phaseBeforeLeave == GamePhase.PlayerTurns) _maybeAdvanceAfterPlayerRemoval(tableId);
            t.lastActivityTimestamp = block.timestamp;
            return;
        }

        playerChips[msg.sender] += p.chips;
        for (uint i = idx; i < t.players.length - 1; i++) t.players[i] = t.players[i + 1];
        t.players.pop();
        playerTableId[msg.sender] = 0;
        emit PlayerLeft(tableId, msg.sender);
        if (t.players.length < 2) {
            t.status = TableStatus.Waiting;
            t.phase = GamePhase.WaitingForPlayers;
            emit PhaseChanged(tableId, GamePhase.WaitingForPlayers);
        }
        t.lastActivityTimestamp = block.timestamp;
    }

    function cashOut(uint tableId) external whenNotPaused atActiveTable(tableId) nonReentrant {
        Table storage t = _getTable(tableId);
        require(t.phase == GamePhase.WaitingForPlayers, "Active hand");
        require(t.pendingKind == PendingKind.None, "Oracle pending");
        uint idx = _getPlayerIndex(tableId, msg.sender);
        Player storage p = t.players[idx];
        require(p.chips > 0, "No chips");
        playerChips[msg.sender] += p.chips;
        for (uint i = idx; i < t.players.length - 1; i++) t.players[i] = t.players[i + 1];
        t.players.pop();
        playerTableId[msg.sender] = 0;
        emit PlayerLeft(tableId, msg.sender);
        if (t.players.length < 2) {
            t.status = TableStatus.Waiting;
            t.phase = GamePhase.WaitingForPlayers;
            emit PhaseChanged(tableId, GamePhase.WaitingForPlayers);
        }
        t.lastActivityTimestamp = block.timestamp;
    }

    // ========= Player intents (oracle fulfills) =========

    function placeBet(uint tableId, uint betAmount) external whenNotPaused atActiveTable(tableId) {
        Table storage t = _getTable(tableId);
        require(t.phase == GamePhase.WaitingForPlayers, "Betting closed");
        require(t.pendingKind == PendingKind.None, "Oracle pending");
        Player storage p = _getPlayerAtTable(tableId, msg.sender);
        require(betAmount >= t.minBuyIn && betAmount <= p.chips, "Invalid bet");
        p.bet = betAmount;
        p.chips -= betAmount;
        p.isActive = true;
        p.hasActed = true;
        p.busted = false;
        emit BetPlaced(tableId, msg.sender, betAmount);
        emit PlayerAction(tableId, msg.sender, "Bet", betAmount);

        uint activeBettors; uint playersEligibleNoBet;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].isActive && t.players[i].bet > 0) activeBettors++;
            else if (t.players[i].chips >= t.minBuyIn && t.players[i].bet == 0) playersEligibleNoBet++;
        }
        if (activeBettors > 0 && (playersEligibleNoBet == 0 || t.players.length == 1)) {
            t.phase = GamePhase.Dealing;
            t.pendingKind = PendingKind.DealHand;
            t.pendingPlayer = address(0);
            emit PhaseChanged(tableId, GamePhase.Dealing);
            emit OracleActionRequired(tableId, PendingKind.DealHand, address(0));
        }
        t.lastActivityTimestamp = block.timestamp;
    }

    function hit(uint tableId) external whenNotPaused atActiveTable(tableId) isMyTurn(tableId) {
        _queuePlayerAction(tableId, msg.sender, PendingKind.Hit, "Hit");
    }

    function stand(uint tableId) external whenNotPaused atActiveTable(tableId) isMyTurn(tableId) {
        _queuePlayerAction(tableId, msg.sender, PendingKind.Stand, "Stand");
    }

    function doubleDown(uint tableId) external whenNotPaused atActiveTable(tableId) isMyTurn(tableId) {
        Player storage p = _getPlayerAtTable(tableId, msg.sender);
        require(p.cardCount == 2, "Only on first two cards");
        require(p.chips >= p.bet, "Insufficient chips");
        _queuePlayerAction(tableId, msg.sender, PendingKind.DoubleDown, "DoubleDown");
    }

    function forceAdvanceOnTimeout(uint tableId) external whenNotPaused {
        Table storage t = _getTable(tableId);
        require(t.phase == GamePhase.PlayerTurns, "Not player phase");
        require(t.pendingKind == PendingKind.None, "Oracle pending");
        require(block.timestamp >= t.lastActivityTimestamp + TURN_TIMEOUT, "Not timed out");
        for (uint i = 0; i < t.players.length; i++) {
            Player storage p = t.players[i];
            if (p.isActive && !p.hasActed && !p.busted) {
                t.pendingKind = PendingKind.Stand;
                t.pendingPlayer = p.addr;
                emit TurnAutoAdvanced(tableId, p.addr, "timeout-stand");
                emit OracleActionRequired(tableId, PendingKind.Stand, p.addr);
                t.lastActivityTimestamp = block.timestamp;
                return;
            }
        }
        t.pendingKind = PendingKind.DealerPlay;
        t.pendingPlayer = address(0);
        emit OracleActionRequired(tableId, PendingKind.DealerPlay, address(0));
        t.lastActivityTimestamp = block.timestamp;
    }

    // ========= Oracle fulfillment =========

    /// @notice Oracle commits deck hash and deals initial cards via encrypted relayer inputs (no plaintext in calldata).
    function oracleDealHand(
        uint tableId,
        bytes32 deckCommitment,
        uint8 deckCursor,
        address[] calldata playerAddrs,
        bytes32[] calldata encRankHandles,
        bytes32[] calldata encSuitHandles,
        bytes calldata inputProof
    ) external onlyOracle {
        Table storage t = _getTable(tableId);
        require(t.pendingKind == PendingKind.DealHand, "Not deal pending");
        require(playerAddrs.length > 0, "No players");
        require(deckCommitment != bytes32(0), "Bad commitment");
        uint8 dealerCards = 2;
        uint expectedCards = playerAddrs.length * 2 + dealerCards;
        require(encRankHandles.length == expectedCards, "Rank count");
        require(encSuitHandles.length == expectedCards, "Suit count");

        uint activeBettors;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].bet > 0 && t.players[i].isActive) activeBettors++;
        }
        require(activeBettors == playerAddrs.length, "Player addrs");

        t.deckCommitment = deckCommitment;
        t.deckIndex = deckCursor;
        emit DeckCommitted(tableId, deckCommitment);

        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].bet > 0 && t.players[i].isActive) {
                delete t.players[i].encRanks;
                delete t.players[i].encSuits;
                t.players[i].cardCount = 0;
                t.players[i].hasActed = false;
                t.players[i].busted = false;
            } else {
                t.players[i].isActive = false;
                t.players[i].hasActed = true;
                t.players[i].busted = false;
                delete t.players[i].encRanks;
                delete t.players[i].encSuits;
                t.players[i].cardCount = 0;
            }
        }
        delete t.dealer.encRanks;
        delete t.dealer.encSuits;
        t.dealer.cardCount = 0;
        t.dealer.hasFinished = false;

        uint hi;
        uint ai;
        for (uint i = 0; i < t.players.length; i++) {
            if (!(t.players[i].bet > 0 && t.players[i].isActive)) continue;
            require(t.players[i].addr == playerAddrs[ai], "Addr mismatch");
            ai++;
            _pushEncryptedCardFromExternal(tableId, t.players[i].addr, encRankHandles[hi], encSuitHandles[hi], inputProof);
            _pushEncryptedCardFromExternal(tableId, t.players[i].addr, encRankHandles[hi + 1], encSuitHandles[hi + 1], inputProof);
            hi += 2;
        }
        require(ai == playerAddrs.length, "Addr coverage");
        for (uint d = 0; d < dealerCards; d++) {
            _pushEncryptedDealerCardFromExternal(tableId, encRankHandles[hi + d], encSuitHandles[hi + d], inputProof);
        }

        _clearPending(t);
        t.phase = GamePhase.PlayerTurns;
        emit PhaseChanged(tableId, GamePhase.PlayerTurns);
        emit HandStarted(tableId);
        t.lastActivityTimestamp = block.timestamp;
    }

    /// @notice Oracle fulfills queued actions. Card values arrive as encrypted relayer inputs (ZK-proof verified on-chain).
    function oracleFulfillPending(
        uint tableId,
        bytes32[] calldata encRankHandles,
        bytes32[] calldata encSuitHandles,
        bytes calldata inputProof,
        bool[] calldata playerBusted,
        bool[] calldata playerHasActed,
        uint8 dealerCardCount,
        bool dealerFinished
    ) external onlyOracle {
        Table storage t = _getTable(tableId);
        PendingKind kind = t.pendingKind;
        require(kind != PendingKind.None, "Nothing pending");

        if (kind == PendingKind.Hit || kind == PendingKind.DoubleDown) {
            address player = t.pendingPlayer;
            require(encRankHandles.length == 1 && encSuitHandles.length == 1, "Need one card");
            _pushEncryptedCardFromExternal(tableId, player, encRankHandles[0], encSuitHandles[0], inputProof);
            Player storage actor = _getPlayerAtTable(tableId, player);
            if (kind == PendingKind.DoubleDown) {
                actor.chips -= actor.bet;
                actor.bet *= 2;
            }
            if (playerBusted.length > 0 && playerBusted[0]) {
                actor.isActive = false;
                actor.hasActed = true;
                actor.busted = true;
                emit PlayerBusted(tableId, player);
                _clearPending(t);
                _advanceToNextPlayer(tableId);
            } else if (kind == PendingKind.DoubleDown || (playerHasActed.length > 0 && playerHasActed[0])) {
                actor.hasActed = true;
                _clearPending(t);
                _advanceToNextPlayer(tableId);
            } else {
                _clearPending(t);
            }
        } else if (kind == PendingKind.Stand) {
            Player storage actor = _getPlayerAtTable(tableId, t.pendingPlayer);
            actor.hasActed = true;
            emit PlayerStood(tableId, t.pendingPlayer);
            _clearPending(t);
            _advanceToNextPlayer(tableId);
        } else if (kind == PendingKind.DealerPlay) {
            require(dealerCardCount >= t.dealer.cardCount, "Bad count");
            uint newCards = dealerCardCount - t.dealer.cardCount;
            require(encRankHandles.length == newCards && encSuitHandles.length == newCards, "Dealer cards");
            for (uint j = 0; j < newCards; j++) {
                _pushEncryptedDealerCardFromExternal(tableId, encRankHandles[j], encSuitHandles[j], inputProof);
            }
            t.dealer.hasFinished = dealerFinished;
            _clearPending(t);
            if (dealerFinished) {
                t.phase = GamePhase.DealerTurn;
                t.pendingKind = PendingKind.Settle;
                t.pendingPlayer = address(0);
                emit PhaseChanged(tableId, GamePhase.DealerTurn);
                emit OracleActionRequired(tableId, PendingKind.Settle, address(0));
            }
        } else {
            revert("Invalid pending kind");
        }

        t.lastActivityTimestamp = block.timestamp;
    }

    function oracleSettleWithOutcomes(
        uint tableId,
        address[] calldata players,
        uint8[] calldata totals,
        Outcome[] calldata outcomes,
        uint[] calldata payouts,
        uint dealerTotal,
        bool dealerBusted
    ) external onlyOracle {
        Table storage t = _getTable(tableId);
        require(t.pendingKind == PendingKind.Settle, "Not settle pending");
        require(players.length == totals.length && players.length == outcomes.length && players.length == payouts.length, "Len");

        uint activeWithBet;
        uint collected;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].bet > 0) {
                activeWithBet++;
                collected += t.players[i].bet;
            }
        }
        require(players.length == activeWithBet, "Player count");
        bankChips += collected;

        uint winCount;
        for (uint i = 0; i < outcomes.length; i++) {
            if (outcomes[i] == Outcome.Win || outcomes[i] == Outcome.Blackjack) winCount++;
        }
        address[] memory winnersAddrs = new address[](winCount);
        uint[] memory winnersPays = new uint[](winCount);
        uint w;

        PlayerResult[] memory resultsTmp = new PlayerResult[](players.length);
        for (uint i = 0; i < players.length; i++) {
            Player storage p = _getPlayerAtTable(tableId, players[i]);
            require(p.bet > 0, "No bet");
            uint payout = payouts[i];
            if (payout > 0) {
                require(bankChips >= payout, "Bank underfunded");
                bankChips -= payout;
                p.chips += payout;
                emit PayoutSent(tableId, players[i], payout);
                if (outcomes[i] == Outcome.Win || outcomes[i] == Outcome.Blackjack) {
                    winnersAddrs[w] = players[i];
                    winnersPays[w] = payout;
                    w++;
                }
            }
            resultsTmp[i] = PlayerResult({
                addr: players[i],
                bet: p.bet,
                total: totals[i],
                outcome: outcomes[i],
                payout: payout
            });
        }
        if (winCount > 0) emit WinnerDetermined(tableId, winnersAddrs, winnersPays);

        _clearPending(t);
        delete t.lastHandResult.results;
        delete t.lastHandResult.dealerEncRanks;
        delete t.lastHandResult.dealerEncSuits;
        t.lastHandResult.dealerTotal = dealerTotal;
        t.lastHandResult.dealerBusted = dealerBusted;
        t.lastHandResult.results = resultsTmp;
        t.lastHandResult.pot = collected;
        t.lastHandResult.timestamp = block.timestamp;
        t.lastHandResult.dealerEncRanks = new euint8[](t.dealer.encRanks.length);
        t.lastHandResult.dealerEncSuits = new euint8[](t.dealer.encSuits.length);
        for (uint er = 0; er < t.dealer.encRanks.length; er++) {
            t.lastHandResult.dealerEncRanks[er] = FHE.makePubliclyDecryptable(t.dealer.encRanks[er]);
        }
        for (uint es = 0; es < t.dealer.encSuits.length; es++) {
            t.lastHandResult.dealerEncSuits[es] = FHE.makePubliclyDecryptable(t.dealer.encSuits[es]);
        }

        t.phase = GamePhase.Showdown;
        emit PhaseChanged(tableId, GamePhase.Showdown);
        emit HandResultStored(tableId, block.timestamp);
        _resetHand(tableId);
    }

    // ========= Internals =========

    function _queuePlayerAction(uint tableId, address player, PendingKind kind, string memory action) internal {
        Table storage t = _getTable(tableId);
        Player storage p = _getPlayerAtTable(tableId, player);
        require(!p.busted, "Player busted");
        t.pendingKind = kind;
        t.pendingPlayer = player;
        emit PlayerAction(tableId, player, action, 0);
        emit OracleActionRequired(tableId, kind, player);
        t.lastActivityTimestamp = block.timestamp;
    }

    function _pushEncryptedCardFromExternal(
        uint tableId,
        address playerAddr,
        bytes32 encRankHandle,
        bytes32 encSuitHandle,
        bytes calldata inputProof
    ) private {
        Table storage t = _getTable(tableId);
        euint8 encRank = FHE.fromExternal(externalEuint8.wrap(encRankHandle), inputProof);
        euint8 encSuit = FHE.fromExternal(externalEuint8.wrap(encSuitHandle), inputProof);
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].addr != playerAddr) continue;
            t.players[i].encRanks.push(encRank);
            t.players[i].encSuits.push(encSuit);
            t.players[i].cardCount++;
            FHE.allow(encRank, playerAddr);
            FHE.allow(encSuit, playerAddr);
            FHE.allow(encRank, address(this));
            FHE.allow(encSuit, address(this));
            FHE.allow(encRank, gameOracle);
            FHE.allow(encSuit, gameOracle);
            emit EncryptedCardDealt(tableId, playerAddr, FHE.toBytes32(encRank), FHE.toBytes32(encSuit));
            break;
        }
    }

    function _pushEncryptedDealerCardFromExternal(
        uint tableId,
        bytes32 encRankHandle,
        bytes32 encSuitHandle,
        bytes calldata inputProof
    ) private {
        Table storage t = _getTable(tableId);
        euint8 encRank = FHE.fromExternal(externalEuint8.wrap(encRankHandle), inputProof);
        euint8 encSuit = FHE.fromExternal(externalEuint8.wrap(encSuitHandle), inputProof);
        t.dealer.encRanks.push(encRank);
        t.dealer.encSuits.push(encSuit);
        t.dealer.cardCount++;
        FHE.allow(encRank, address(this));
        FHE.allow(encSuit, address(this));
        FHE.allow(encRank, gameOracle);
        FHE.allow(encSuit, gameOracle);
        emit EncryptedCardDealt(tableId, address(this), FHE.toBytes32(encRank), FHE.toBytes32(encSuit));
    }

    function _clearPending(Table storage t) private {
        t.pendingKind = PendingKind.None;
        t.pendingPlayer = address(0);
    }

    function _getTable(uint tableId) private view returns (Table storage) {
        require(tableId > 0 && tableId <= tables.length, "Table DNE");
        return tables[tableId - 1];
    }

    function _getPlayerIndex(uint tableId, address playerAddr) private view returns (uint) {
        Table storage t = _getTable(tableId);
        for (uint i = 0; i < t.players.length; i++) if (t.players[i].addr == playerAddr) return i;
        revert("Player not found");
    }

    function _getPlayerAtTable(uint tableId, address playerAddr) private view returns (Player storage) {
        return _getTable(tableId).players[_getPlayerIndex(tableId, playerAddr)];
    }

    function _isMyTurnInternal(uint tableId, address who) private view returns (bool) {
        Table storage t = _getTable(tableId);
        if (t.phase != GamePhase.PlayerTurns) return false;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].isActive && !t.players[i].hasActed && !t.players[i].busted) {
                if (t.players[i].addr == who) {
                    for (uint j = 0; j < i; j++) {
                        if (t.players[j].isActive && !t.players[j].hasActed && !t.players[j].busted) return false;
                    }
                    return true;
                }
                return false;
            }
        }
        return false;
    }

    function _nextPlayerAddr(uint tableId) private view returns (address) {
        if (tableId == 0 || tableId > tables.length) return address(0);
        Table storage t = tables[tableId - 1];
        if (t.phase != GamePhase.PlayerTurns) return address(0);
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].isActive && !t.players[i].hasActed && !t.players[i].busted) return t.players[i].addr;
        }
        return address(0);
    }

    function _buildTableSummary(Table storage t) private view returns (TableSummary memory) {
        uint pot;
        for (uint i = 0; i < t.players.length; i++) pot += t.players[i].bet;
        return TableSummary({
            id: t.id,
            status: t.status,
            minBuyIn: t.minBuyIn,
            maxBuyIn: t.maxBuyIn,
            phase: t.phase,
            playersSeated: uint8(t.players.length),
            pot: pot
        });
    }

    function _maybeAdvanceAfterPlayerRemoval(uint tableId) private {
        Table storage t = _getTable(tableId);
        if (t.phase != GamePhase.PlayerTurns) return;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].isActive && !t.players[i].hasActed && !t.players[i].busted) return;
        }
        t.pendingKind = PendingKind.DealerPlay;
        t.pendingPlayer = address(0);
        emit OracleActionRequired(tableId, PendingKind.DealerPlay, address(0));
    }

    function _advanceToNextPlayer(uint tableId) internal {
        Table storage t = _getTable(tableId);
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].isActive && !t.players[i].hasActed && !t.players[i].busted) return;
        }
        t.pendingKind = PendingKind.DealerPlay;
        t.pendingPlayer = address(0);
        emit OracleActionRequired(tableId, PendingKind.DealerPlay, address(0));
    }

    function _deckCommitment(uint8[] calldata deckOrder) private pure returns (bytes32) {
        require(deckOrder.length == 52, "Bad deck");
        bytes memory buf = new bytes(52);
        for (uint i = 0; i < 52; i++) {
            buf[i] = bytes1(deckOrder[i]);
        }
        return keccak256(buf);
    }

    function _resetHand(uint tableId) internal {
        Table storage t = _getTable(tableId);
        t.phase = GamePhase.WaitingForPlayers;
        emit PhaseChanged(tableId, GamePhase.WaitingForPlayers);
        for (uint i = 0; i < t.players.length; i++) {
            delete t.players[i].encRanks;
            delete t.players[i].encSuits;
            t.players[i].cardCount = 0;
            t.players[i].isActive = false;
            t.players[i].hasActed = false;
            t.players[i].busted = false;
            t.players[i].bet = 0;
        }
        delete t.dealer.encRanks;
        delete t.dealer.encSuits;
        t.dealer.cardCount = 0;
        t.dealer.hasFinished = false;
        t.deckCommitment = bytes32(0);
        t.deckIndex = 0;
        _clearPending(t);
        t.lastActivityTimestamp = block.timestamp;
    }

    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero addr");
        owner = newOwner;
    }
}