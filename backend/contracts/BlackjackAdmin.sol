// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BlackjackOracle } from "./BlackjackOracle.sol";

/// @dev Owner/oracle configuration and emergency pause controls.
abstract contract BlackjackAdmin is BlackjackOracle {
    function setGameOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        emit GameOracleUpdated(gameOracle, newOracle);
        gameOracle = newOracle;
    }

    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }
}