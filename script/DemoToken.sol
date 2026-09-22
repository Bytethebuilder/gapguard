// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice Fixed-supply demo token for the Gapguard showcase pool. The whole supply is minted to the
///         deployer once; there is no mint, no burn and no owner. It represents nothing.
contract DemoToken is ERC20 {
    constructor(string memory name, string memory symbol, uint256 supply) ERC20(name, symbol, 18) {
        _mint(msg.sender, supply);
    }
}
