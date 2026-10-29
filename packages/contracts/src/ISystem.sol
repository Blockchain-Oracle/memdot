// SPDX-License-Identifier: MIT
// Subset of the pallet-revive System precompile interface (paritytech/polkadot-sdk,
// substrate/frame/revive/uapi/sol/ISystem.sol, MIT). Only the calls MemDot uses, all verified
// live on Portaldot V3 on 2026-10-29.
pragma solidity ^0.8.0;

address constant SYSTEM_ADDR = 0x0000000000000000000000000000000000000900;

interface ISystem {
    /// Computes the BLAKE2 256-bit hash on the given input.
    function hashBlake256(bytes memory input) external pure returns (bytes32 digest);

    /// Retrieve the account id for a specified `H160` address (fallback id if unmapped).
    function toAccountId(address input) external view returns (bytes memory account_id);

    /// Verify a sr25519 signature.
    function sr25519Verify(uint8[64] calldata signature, bytes calldata message, bytes32 publicKey)
        external
        view
        returns (bool);
}
