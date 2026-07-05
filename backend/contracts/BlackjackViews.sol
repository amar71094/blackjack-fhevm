// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { FHE, euint8 } from "@fhevm/solidity/lib/FHE.sol";
import { BlackjackMathLib } from "./libraries/BlackjackMathLib.sol";
import { BlackjackStorage } from "./BlackjackStorage.sol";

/// @dev Read-only endpoints for lobby, play UI, and oracle verification.
abstract contract BlackjackViews is BlackjackStorage {
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
        return (BlackjackMathLib.CHIPS_PER_ETH, BlackjackMathLib.WEI_PER_CHIP);
    }

    function deckCommitmentOf(uint8[] calldata deckOrder) external pure returns (bytes32) {
        return BlackjackMathLib.deckCommitment(deckOrder);
    }

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
}