// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ISystem, SYSTEM_ADDR} from "./ISystem.sol";

/// @title MemDot registry
/// @notice A public, owner-signed log of what MemDot stores on Portaldot V3 TransactionStorage and
/// who may read it: spaces, objects, grants, sharing keys and agents. Bytes never reach this
/// contract; records reference blake2b-256 content hashes (a CID is a fixed prefix plus that hash).
/// Owners sign each record with sr25519, anyone may submit it, and the signature is checked
/// on-chain with the System precompile.
/// @dev The contract keeps no state, only logs, because Revive holds about 0.08 tPOT per byte of
/// code and about 4 tPOT per stored word, while a log costs only the call's fee. Ownership holds
/// without state: a space id is derived from its owner, so nobody can record anything in another
/// owner's space. Records carry the signed nonce, and readers apply an (owner, nonce) pair once,
/// which makes replaying a signed record a no-op. `action` and the ABI-encoded `data` it describes
/// are listed in src/actions.ts; new kinds of record need no redeploy.
contract MemDotRegistry {
    ISystem private constant SYSTEM = ISystem(SYSTEM_ADDR);
    string private constant DOMAIN = "memdot/registry/v1";

    event Recorded(
        bytes32 indexed owner, bytes32 indexed spaceId, uint8 indexed action, uint64 nonce, bytes data
    );

    error NotAuthorized();

    /// @param salt the owner's name for a space; zero for records about the account itself.
    function record(
        bytes32 owner,
        bytes32 salt,
        uint8 action,
        bytes calldata data,
        uint64 nonce,
        uint8[64] calldata sig
    ) external {
        bytes memory message =
            signingMessage(owner, nonce, keccak256(abi.encode(salt, action, keccak256(data))));
        if (
            !SYSTEM.sr25519Verify(sig, message, owner)
            // Browser wallets sign raw bytes wrapped as <Bytes>…</Bytes>.
            && !SYSTEM.sr25519Verify(sig, abi.encodePacked("<Bytes>", message, "</Bytes>"), owner)
        ) revert NotAuthorized();
        bytes32 spaceId =
            salt == bytes32(0) ? bytes32(0) : SYSTEM.hashBlake256(abi.encodePacked(owner, salt));
        emit Recorded(owner, spaceId, action, nonce, data);
    }

    /// @notice The exact bytes an owner signs to authorize `actionHash` at `nonce`.
    function signingMessage(bytes32 owner, uint64 nonce, bytes32 actionHash)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(DOMAIN, block.chainid, address(this), owner, nonce, actionHash);
    }
}
