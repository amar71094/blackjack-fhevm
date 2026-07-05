// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BlackjackViews } from "./BlackjackViews.sol";

/// @dev Wallet chip purchases, withdrawals, and dealer bank funding.
abstract contract BlackjackEconomy is BlackjackViews {
    function claimFreeChips() external whenNotPaused {
        if (hasClaimedFreeChips[msg.sender]) revert AlreadyClaimedFreeChips();
        if (playerTableId[msg.sender] != 0) revert LeaveTableFirst();
        hasClaimedFreeChips[msg.sender] = true;
        playerChips[msg.sender] += FREE_CHIP_GRANT;
        emit FreeChipsClaimed(msg.sender, FREE_CHIP_GRANT);
    }

    function buyChips() external payable whenNotPaused nonReentrant {
        if (msg.value == 0) revert SendEth();
        if (playerTableId[msg.sender] != 0) revert LeaveTableFirst();
        uint chips = ethToChips(msg.value);
        if (chips == 0) revert AmountTooSmall();
        playerChips[msg.sender] += chips;
        withdrawableChips[msg.sender] += chips;
        emit ChipsPurchased(msg.sender, msg.value, chips);
    }

    function withdrawChips(uint chipAmount) external whenNotPaused nonReentrant {
        if (chipAmount == 0) revert ZeroAmount();
        if (playerTableId[msg.sender] != 0) revert LeaveTableFirst();
        if (playerChips[msg.sender] < chipAmount) revert InsufficientChips();
        if (chipAmount > withdrawableChips[msg.sender]) revert PromoChipsNotWithdrawable();
        uint weiAmount = chipsToWei(chipAmount);
        if (address(this).balance < weiAmount) revert ContractLacksEth();
        playerChips[msg.sender] -= chipAmount;
        withdrawableChips[msg.sender] -= chipAmount;
        (bool ok,) = payable(msg.sender).call{value: weiAmount}("");
        if (!ok) revert EthTransferFailed();
        emit ChipsWithdrawn(msg.sender, chipAmount, weiAmount);
    }

    function getPlayerChips(address player) external view returns (uint) { return playerChips[player]; }

    function topUpTableChips(uint tableId, uint amount) external whenNotPaused atActiveTable(tableId) {
        Table storage t = _getTable(tableId);
        if (t.phase != GamePhase.WaitingForPlayers) revert OnlyBetweenHands();
        if (t.pendingKind != PendingKind.None) revert OraclePending();
        if (playerChips[msg.sender] < amount) revert InsufficientChips();
        uint idx = _getPlayerIndex(tableId, msg.sender);
        playerChips[msg.sender] -= amount;
        t.players[idx].chips += amount;
        t.players[idx].withdrawableStack += _moveWithdrawableFromWallet(msg.sender, amount);
        t.lastActivityTimestamp = block.timestamp;
        emit TableChipsToppedUp(tableId, msg.sender, amount);
    }

    function fundBank() external payable onlyOwner {
        if (msg.value == 0) revert NoEthSent();
        uint chipsAdded = ethToChips(msg.value);
        uint ethBacked = ethToChips(address(this).balance);
        if (bankChips + chipsAdded > ethBacked) revert ExceedsEthBacking();
        bankChips += chipsAdded;
        emit BankFunded(msg.value, chipsAdded);
    }

    function defundBank(uint chipAmount) external onlyOwner nonReentrant {
        if (chipAmount == 0 || chipAmount > bankChips) revert InvalidAmount();
        uint weiAmount = chipsToWei(chipAmount);
        if (address(this).balance < weiAmount) revert ContractLacksEth();
        bankChips -= chipAmount;
        (bool ok,) = payable(msg.sender).call{value: weiAmount}("");
        if (!ok) revert EthTransferFailed();
        emit BankDefunded(chipAmount, weiAmount);
    }
}