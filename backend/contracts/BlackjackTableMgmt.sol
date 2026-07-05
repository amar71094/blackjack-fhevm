// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BlackjackEconomy } from "./BlackjackEconomy.sol";

/// @dev Table creation, seating, leaving, and cash-out.
abstract contract BlackjackTableMgmt is BlackjackEconomy {
    function createTable(uint _minBuyIn, uint _maxBuyIn) external whenNotPaused {
        if (tables.length >= MAX_TABLES) revert MaxTables();
        if (_minBuyIn == 0 || _maxBuyIn < _minBuyIn) revert InvalidStakes();
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
        if (t.phase != GamePhase.WaitingForPlayers) revert HandInProgress();
        if (t.pendingKind != PendingKind.None) revert OraclePending();
        if (t.players.length >= MAX_PLAYERS) revert TableFull();
        if (playerTableId[msg.sender] != 0) revert AlreadyAtTable();
        if (buyInAmount < t.minBuyIn || buyInAmount > t.maxBuyIn) revert InvalidBuyIn();
        if (playerChips[msg.sender] < buyInAmount) revert InsufficientChips();
        playerChips[msg.sender] -= buyInAmount;
        t.players.push();
        Player storage p = t.players[t.players.length - 1];
        p.addr = msg.sender;
        p.chips = buyInAmount;
        p.withdrawableStack = _moveWithdrawableFromWallet(msg.sender, buyInAmount);
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
        if (t.pendingKind != PendingKind.None && t.pendingPlayer != msg.sender) revert OraclePending();
        uint idx = _getPlayerIndex(tableId, msg.sender);
        Player storage p = t.players[idx];
        GamePhase phaseBeforeLeave = t.phase;

        if (t.phase != GamePhase.WaitingForPlayers) {
            if (p.bet > 0) {
                uint ethBacked = ethToChips(address(this).balance);
                if (bankChips < ethBacked) {
                    uint headroom = ethBacked - bankChips;
                    bankChips += p.bet > headroom ? headroom : p.bet;
                }
                p.bet = 0;
            }
            playerChips[msg.sender] += p.chips;
            _returnWithdrawableStackToWallet(msg.sender, p);
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
        _returnWithdrawableStackToWallet(msg.sender, p);
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
        if (t.phase != GamePhase.WaitingForPlayers) revert ActiveHand();
        if (t.pendingKind != PendingKind.None) revert OraclePending();
        uint idx = _getPlayerIndex(tableId, msg.sender);
        Player storage p = t.players[idx];
        if (p.chips == 0) revert NoChips();
        playerChips[msg.sender] += p.chips;
        _returnWithdrawableStackToWallet(msg.sender, p);
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
}