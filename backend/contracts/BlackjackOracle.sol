// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { FHE, euint8, externalEuint8 } from "@fhevm/solidity/lib/FHE.sol";
import { BlackjackGameplay } from "./BlackjackGameplay.sol";

/// @dev Oracle-only deal, fulfill, and settlement paths (FHE card ingestion).
abstract contract BlackjackOracle is BlackjackGameplay {
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
        if (t.pendingKind != PendingKind.DealHand) revert NotDealPending();
        if (playerAddrs.length == 0) revert NoPlayers();
        if (deckCommitment == bytes32(0)) revert BadCommitment();
        uint8 dealerCards = 2;
        uint expectedCards = playerAddrs.length * 2 + dealerCards;
        if (encRankHandles.length != expectedCards) revert RankCountMismatch();
        if (encSuitHandles.length != expectedCards) revert RankCountMismatch();

        uint activeBettors;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].bet > 0 && t.players[i].isActive) activeBettors++;
        }
        if (activeBettors != playerAddrs.length) revert PlayerAddrsMismatch();

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
            if (t.players[i].addr != playerAddrs[ai]) revert AddrMismatch();
            ai++;
            _pushEncryptedCardFromExternal(tableId, t.players[i].addr, encRankHandles[hi], encSuitHandles[hi], inputProof);
            _pushEncryptedCardFromExternal(tableId, t.players[i].addr, encRankHandles[hi + 1], encSuitHandles[hi + 1], inputProof);
            hi += 2;
        }
        if (ai != playerAddrs.length) revert AddrCoverage();
        for (uint d = 0; d < dealerCards; d++) {
            _pushEncryptedDealerCardFromExternal(tableId, encRankHandles[hi + d], encSuitHandles[hi + d], inputProof);
        }

        _clearPending(t);
        t.phase = GamePhase.PlayerTurns;
        emit PhaseChanged(tableId, GamePhase.PlayerTurns);
        emit HandStarted(tableId);
        t.lastActivityTimestamp = block.timestamp;
    }

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
        if (kind == PendingKind.None) revert NothingPending();

        if (kind == PendingKind.Hit || kind == PendingKind.DoubleDown) {
            address player = t.pendingPlayer;
            Player storage actor = _getPlayerAtTable(tableId, player);
            if (actor.busted) {
                _resolveBustedPending(tableId, t);
                return;
            }
            if (encRankHandles.length != 1 || encSuitHandles.length != 1) revert NeedOneCard();
            _pushEncryptedCardFromExternal(tableId, player, encRankHandles[0], encSuitHandles[0], inputProof);
            if (kind == PendingKind.DoubleDown) {
                if (actor.chips < actor.bet) revert InsufficientChips();
                uint extraBet = actor.bet;
                uint extraWd = actor.withdrawableStack >= extraBet ? extraBet : actor.withdrawableStack;
                actor.withdrawableStack -= extraWd;
                actor.withdrawableBet += extraWd;
                actor.chips -= extraBet;
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
            if (dealerCardCount < t.dealer.cardCount) revert BadDealerCount();
            uint newCards = dealerCardCount - t.dealer.cardCount;
            if (encRankHandles.length != newCards || encSuitHandles.length != newCards) revert DealerCardCountMismatch();
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
            revert InvalidPendingKind();
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
        if (t.pendingKind != PendingKind.Settle) revert NotSettlePending();
        if (players.length != totals.length || players.length != outcomes.length || players.length != payouts.length) {
            revert ArrayLengthMismatch();
        }

        uint activeWithBet;
        uint collected;
        for (uint i = 0; i < t.players.length; i++) {
            if (t.players[i].bet > 0) {
                activeWithBet++;
                collected += t.players[i].bet;
            }
        }
        if (players.length != activeWithBet) revert PlayerCountMismatch();

        uint totalPayout;
        for (uint i = 0; i < players.length; i++) {
            Player storage p = _getPlayerAtTable(tableId, players[i]);
            if (p.bet == 0) revert NoBet();
            if (payouts[i] != _expectedPayout(p.bet, outcomes[i])) revert BadPayout();
            totalPayout += payouts[i];
        }
        if (bankChips + collected < totalPayout) revert BankUnderfunded();
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
            uint payout = payouts[i];
            if (payout > 0) {
                bankChips -= payout;
                p.chips += payout;
                uint wdBet = p.withdrawableBet;
                if (outcomes[i] == Outcome.Push) {
                    p.withdrawableStack += wdBet;
                } else if (wdBet > 0 && (outcomes[i] == Outcome.Win || outcomes[i] == Outcome.Blackjack)) {
                    p.withdrawableStack += wdBet + (payout - p.bet);
                }
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

        _capBankChips();

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

    function _resolveBustedPending(uint tableId, Table storage t) private {
        address player = t.pendingPlayer;
        Player storage actor = _getPlayerAtTable(tableId, player);
        actor.hasActed = true;
        _clearPending(t);
        _advanceToNextPlayer(tableId);
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
}