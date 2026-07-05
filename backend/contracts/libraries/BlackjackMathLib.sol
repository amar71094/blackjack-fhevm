// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Pure chip math and payout helpers (external library to shrink main contract bytecode).
library BlackjackMathLib {
    uint internal constant CHIPS_PER_ETH = 100_000_000;
    uint internal constant WEI_PER_CHIP = 1e18 / CHIPS_PER_ETH;
    uint internal constant BLACKJACK_PAYOUT_NUM = 3;
    uint internal constant BLACKJACK_PAYOUT_DEN = 2;

    uint8 internal constant OUTCOME_LOSE = 0;
    uint8 internal constant OUTCOME_WIN = 1;
    uint8 internal constant OUTCOME_PUSH = 2;
    uint8 internal constant OUTCOME_BLACKJACK = 3;

    function ethToChips(uint weiAmount) external pure returns (uint) {
        return weiAmount / WEI_PER_CHIP;
    }

    function chipsToWei(uint chipAmount) external pure returns (uint) {
        return chipAmount * WEI_PER_CHIP;
    }

    function expectedPayout(uint bet, uint8 outcome) external pure returns (uint) {
        if (outcome == OUTCOME_BLACKJACK) return (bet * BLACKJACK_PAYOUT_NUM) / BLACKJACK_PAYOUT_DEN;
        if (outcome == OUTCOME_WIN) return bet * 2;
        if (outcome == OUTCOME_PUSH) return bet;
        return 0;
    }

    function deckCommitment(uint8[] calldata deckOrder) external pure returns (bytes32) {
        require(deckOrder.length == 52, "Bad deck");
        bytes memory buf = new bytes(52);
        for (uint i = 0; i < 52; i++) {
            buf[i] = bytes1(deckOrder[i]);
        }
        return keccak256(buf);
    }
}