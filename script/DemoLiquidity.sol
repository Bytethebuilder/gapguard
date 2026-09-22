// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice Add-only liquidity holder for the Gapguard demo pool. It owns the position and has no way to
///         remove it, so the demo liquidity is locked for good and nobody can pull it out from under
///         the showcase. Funds it with its own token balance.
contract DemoLiquidity is IUnlockCallback {
    error NotPoolManager();
    error NotDeployer();
    error AddOnly();

    IPoolManager public immutable poolManager;
    address public immutable deployer;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
        deployer = msg.sender;
    }

    function add(PoolKey calldata key, ModifyLiquidityParams calldata params) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (params.liquidityDelta <= 0) revert AddOnly();
        poolManager.unlock(abi.encode(key, params));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, ModifyLiquidityParams memory params) = abi.decode(data, (PoolKey, ModifyLiquidityParams));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(key, params, "");
        _pay(key.currency0, delta.amount0());
        _pay(key.currency1, delta.amount1());
        return "";
    }

    function _pay(Currency currency, int128 amount) internal {
        if (amount >= 0) return;
        poolManager.sync(currency);
        currency.transfer(address(poolManager), uint128(-amount));
        poolManager.settle();
    }
}
