// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BlackjackTableMgmt } from "./BlackjackTableMgmt.sol";

/// @dev Player betting intents and turn actions (oracle fulfills on-chain).
abstract contract BlackjackGameplay is BlackjackTableMgmt {
    function placeBet(uint tableId, uint betAmount) external whenNotPaused atActiveTable(tableId) {
        Table storage t = _getTable(tableId);
        if (t.phase != GamePhase.WaitingForPlayers) revert BettingClosed();
        if (t.pendingKind != PendingKind.None) revert OraclePending();
        Player storage p = _getPlayerAtTable(tableId, msg.sender);
        if (p.bet != 0) revert AlreadyBet();
        if (betAmount < t.minBuyIn || betAmount > p.chips) revert InvalidBet();
        p.bet = betAmount;
        p.withdrawableBet = p.withdrawableStack >= betAmount ? betAmount : p.withdrawableStack;
        p.withdrawableStack -= p.withdrawableBet;
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
        if (p.cardCount != 2) revert OnlyFirstTwoCards();
        if (p.chips < p.bet) revert InsufficientChips();
        _queuePlayerAction(tableId, msg.sender, PendingKind.DoubleDown, "DoubleDown");
    }

    function forceAdvanceOnTimeout(uint tableId) external whenNotPaused {
        Table storage t = _getTable(tableId);
        if (t.phase != GamePhase.PlayerTurns) revert NotPlayerPhase();
        if (t.pendingKind != PendingKind.None) revert OraclePending();
        if (block.timestamp < t.lastActivityTimestamp + TURN_TIMEOUT) revert NotTimedOut();
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

    function _queuePlayerAction(uint tableId, address player, PendingKind kind, string memory action) internal {
        Table storage t = _getTable(tableId);
        Player storage p = _getPlayerAtTable(tableId, player);
        if (p.busted) revert PlayerBustedAction();
        t.pendingKind = kind;
        t.pendingPlayer = player;
        emit PlayerAction(tableId, player, action, 0);
        emit OracleActionRequired(tableId, kind, player);
        t.lastActivityTimestamp = block.timestamp;
    }
}