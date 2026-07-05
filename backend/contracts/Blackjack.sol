// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * CipherJack — FHE-first blackjack (deployable entrypoint).
 * Logic is split across inherited modules under contracts/ for maintainability.
 * - BlackjackStorage: types, state, shared internals
 * - BlackjackViews: read-only API
 * - BlackjackEconomy: chips / bank
 * - BlackjackTableMgmt: seating lifecycle
 * - BlackjackGameplay: player intents
 * - BlackjackOracle: oracle fulfillment + FHE cards
 * - BlackjackAdmin: owner controls
 * - libraries/BlackjackMathLib: pure math (linked external library)
 */

import { BlackjackAdmin } from "./BlackjackAdmin.sol";

contract Blackjack is BlackjackAdmin {}