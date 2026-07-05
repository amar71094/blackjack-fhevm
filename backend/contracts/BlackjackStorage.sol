// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { euint8 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { BlackjackMathLib } from "./libraries/BlackjackMathLib.sol";

/// @dev Shared types, state, events, modifiers, and internal helpers for CipherJack.
abstract contract BlackjackStorage is ZamaEthereumConfig {
    enum TableStatus { Waiting, Active, Closed }
    enum GamePhase { WaitingForPlayers, Dealing, PlayerTurns, DealerTurn, Showdown, Completed }
    enum Outcome { Lose, Win, Push, Blackjack }
    enum PendingKind { None, DealHand, Hit, Stand, DoubleDown, DealerPlay, Settle }

    struct Player {
        address addr;
        uint chips;
        uint bet;
        uint withdrawableStack;
        uint withdrawableBet;
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
    uint public constant FREE_CHIP_GRANT = 2_000;

    mapping(address => uint) public playerTableId;
    mapping(address => bool) public hasClaimedFreeChips;
    mapping(address => uint) public playerChips;
    mapping(address => uint) public withdrawableChips;
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

    error ReentrancyGuardActive();
    error ContractPaused();
    error OnlyOwner();
    error OnlyOracle();
    error TableDNE();
    error NotAtTable();
    error TableInactive();
    error NotPlayerPhase();
    error OraclePending();
    error NotYourTurn();
    error ZeroAddress();
    error AlreadyClaimedFreeChips();
    error LeaveTableFirst();
    error SendEth();
    error AmountTooSmall();
    error ZeroAmount();
    error InsufficientChips();
    error PromoChipsNotWithdrawable();
    error ContractLacksEth();
    error EthTransferFailed();
    error OnlyBetweenHands();
    error NoEthSent();
    error ExceedsEthBacking();
    error InvalidAmount();
    error MaxTables();
    error InvalidStakes();
    error HandInProgress();
    error TableFull();
    error AlreadyAtTable();
    error InvalidBuyIn();
    error ActiveHand();
    error NoChips();
    error BettingClosed();
    error AlreadyBet();
    error InvalidBet();
    error OnlyFirstTwoCards();
    error NotTimedOut();
    error NotDealPending();
    error NoPlayers();
    error BadCommitment();
    error RankCountMismatch();
    error PlayerAddrsMismatch();
    error AddrMismatch();
    error AddrCoverage();
    error NothingPending();
    error NeedOneCard();
    error InvalidPendingKind();
    error BadDealerCount();
    error DealerCardCountMismatch();
    error NotSettlePending();
    error ArrayLengthMismatch();
    error PlayerCountMismatch();
    error NoBet();
    error BadPayout();
    error BankUnderfunded();
    error PlayerBustedAction();
    error PlayerNotFound();

    modifier nonReentrant() {
        if (_locked) revert ReentrancyGuardActive();
        _locked = true;
        _;
        _locked = false;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != gameOracle) revert OnlyOracle();
        _;
    }

    modifier atActiveTable(uint tableId) {
        if (tableId == 0 || tableId > tables.length) revert TableDNE();
        if (playerTableId[msg.sender] != tableId) revert NotAtTable();
        _;
    }

    modifier isMyTurn(uint tableId) {
        Table storage t = _getTable(tableId);
        if (t.status != TableStatus.Active) revert TableInactive();
        if (t.phase != GamePhase.PlayerTurns) revert NotPlayerPhase();
        if (t.pendingKind != PendingKind.None) revert OraclePending();
        if (!_isMyTurnInternal(tableId, msg.sender)) revert NotYourTurn();
        _;
    }

    constructor() {
        owner = msg.sender;
        gameOracle = msg.sender;
    }

    function ethToChips(uint weiAmount) public pure returns (uint) {
        return BlackjackMathLib.ethToChips(weiAmount);
    }

    function chipsToWei(uint chipAmount) public pure returns (uint) {
        return BlackjackMathLib.chipsToWei(chipAmount);
    }

    function _expectedPayout(uint bet, Outcome outcome) internal pure returns (uint) {
        return BlackjackMathLib.expectedPayout(bet, uint8(outcome));
    }

    function _moveWithdrawableFromWallet(address player, uint amount) internal returns (uint moved) {
        uint walletWd = withdrawableChips[player];
        moved = amount < walletWd ? amount : walletWd;
        if (moved > 0) withdrawableChips[player] -= moved;
    }

    function _returnWithdrawableStackToWallet(address player, Player storage p) internal {
        if (p.withdrawableStack > 0) {
            withdrawableChips[player] += p.withdrawableStack;
            p.withdrawableStack = 0;
        }
    }

    function _capBankChips() internal {
        uint ethBacked = ethToChips(address(this).balance);
        if (bankChips > ethBacked) bankChips = ethBacked;
    }

    function _clearPending(Table storage t) internal {
        t.pendingKind = PendingKind.None;
        t.pendingPlayer = address(0);
    }

    function _getTable(uint tableId) internal view returns (Table storage) {
        if (tableId == 0 || tableId > tables.length) revert TableDNE();
        return tables[tableId - 1];
    }

    function _getPlayerIndex(uint tableId, address playerAddr) internal view returns (uint) {
        Table storage t = _getTable(tableId);
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].addr == playerAddr) return i;
        }
        revert PlayerNotFound();
    }

    function _getPlayerAtTable(uint tableId, address playerAddr) internal view returns (Player storage) {
        return _getTable(tableId).players[_getPlayerIndex(tableId, playerAddr)];
    }

    function _isMyTurnInternal(uint tableId, address who) internal view returns (bool) {
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

    function _nextPlayerAddr(uint tableId) internal view returns (address) {
        if (tableId == 0 || tableId > tables.length) return address(0);
        Table storage t = tables[tableId - 1];
        if (t.phase != GamePhase.PlayerTurns) return address(0);
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].isActive && !t.players[i].hasActed && !t.players[i].busted) return t.players[i].addr;
        }
        return address(0);
    }

    function _buildTableSummary(Table storage t) internal view returns (TableSummary memory) {
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

    function _maybeAdvanceAfterPlayerRemoval(uint tableId) internal {
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
            t.players[i].withdrawableBet = 0;
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
}