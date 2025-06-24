// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal router mock that only exposes the WETH getter used by the factory
contract MockRouter {
    address private immutable weth;

    constructor(address _weth) {
        weth = _weth;
    }

    function WETH() external view returns (address) {
        return weth;
    }
}

