// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SYSTEM_ADDR} from "../src/ISystem.sol";
import {MemDotRegistry} from "../src/MemDotRegistry.sol";

/// Stand-in for Portaldot's System precompile. The real sr25519Verify and hashBlake256 were
/// checked live on V3 (scripts/check-precompiles.ts); here a "signature" is keccak(pk, message).
contract MockSystem {
    function hashBlake256(bytes memory input) external pure returns (bytes32) {
        return keccak256(input);
    }

    function sr25519Verify(uint8[64] calldata sig, bytes calldata message, bytes32 pk)
        external
        pure
        returns (bool)
    {
        bytes32 expected = keccak256(abi.encodePacked(pk, message));
        for (uint256 i = 0; i < 32; i++) {
            if (sig[i] != uint8(expected[i])) return false;
        }
        return true;
    }
}

contract MemDotRegistryTest is Test {
    MemDotRegistry registry;

    bytes32 constant OWNER = keccak256("owner");
    bytes32 constant STRANGER = keccak256("stranger");
    bytes32 constant SALT = bytes32("space-1");
    address constant RELAYER = address(0xBEEF);
    uint8 constant ACTION = 4;
    uint64 constant NONCE = 7;
    bytes constant DATA = hex"c0ffee";

    event Recorded(
        bytes32 indexed owner, bytes32 indexed spaceId, uint8 indexed action, uint64 nonce, bytes data
    );

    function setUp() public {
        vm.etch(SYSTEM_ADDR, address(new MockSystem()).code);
        registry = new MemDotRegistry();
        vm.startPrank(RELAYER);
    }

    function sign(bytes32 pk, bytes memory message) internal pure returns (uint8[64] memory sig) {
        bytes32 digest = keccak256(abi.encodePacked(pk, message));
        for (uint256 i = 0; i < 32; i++) sig[i] = uint8(digest[i]);
    }

    function messageOf(bytes32 owner, bytes32 salt, uint8 action, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        return registry.signingMessage(
            owner, NONCE, keccak256(abi.encode(salt, action, keccak256(data)))
        );
    }

    function spaceIdOf(bytes32 owner) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, SALT));
    }

    function test_relayerSubmitsAnOwnerSignedRecord() public {
        uint8[64] memory sig = sign(OWNER, messageOf(OWNER, SALT, ACTION, DATA));
        vm.expectEmit(address(registry));
        emit Recorded(OWNER, spaceIdOf(OWNER), ACTION, NONCE, DATA);
        registry.record(OWNER, SALT, ACTION, DATA, NONCE, sig);
    }

    function test_accountRecordsHaveNoSpace() public {
        uint8[64] memory sig = sign(OWNER, messageOf(OWNER, bytes32(0), ACTION, DATA));
        vm.expectEmit(address(registry));
        emit Recorded(OWNER, bytes32(0), ACTION, NONCE, DATA);
        registry.record(OWNER, bytes32(0), ACTION, DATA, NONCE, sig);
    }

    function test_rejectsASignatureFromAnyoneElse() public {
        uint8[64] memory forged = sign(STRANGER, messageOf(OWNER, SALT, ACTION, DATA));
        vm.expectRevert(MemDotRegistry.NotAuthorized.selector);
        registry.record(OWNER, SALT, ACTION, DATA, NONCE, forged);
    }

    function test_aSignatureCoversEveryField() public {
        uint8[64] memory sig = sign(OWNER, messageOf(OWNER, SALT, ACTION, DATA));
        vm.expectRevert(MemDotRegistry.NotAuthorized.selector);
        registry.record(OWNER, SALT, ACTION + 1, DATA, NONCE, sig);
        vm.expectRevert(MemDotRegistry.NotAuthorized.selector);
        registry.record(OWNER, SALT, ACTION, hex"c0ffef", NONCE, sig);
        vm.expectRevert(MemDotRegistry.NotAuthorized.selector);
        registry.record(OWNER, bytes32("space-2"), ACTION, DATA, NONCE, sig);
        vm.expectRevert(MemDotRegistry.NotAuthorized.selector);
        registry.record(OWNER, SALT, ACTION, DATA, NONCE + 1, sig);
    }

    function test_acceptsWalletBytesWrapping() public {
        bytes memory wrapped =
            abi.encodePacked("<Bytes>", messageOf(OWNER, SALT, ACTION, DATA), "</Bytes>");
        vm.expectEmit(address(registry));
        emit Recorded(OWNER, spaceIdOf(OWNER), ACTION, NONCE, DATA);
        registry.record(OWNER, SALT, ACTION, DATA, NONCE, sign(OWNER, wrapped));
    }

    function test_aStrangerCannotWriteIntoAnOwnersSpace() public {
        // The same salt signed by a stranger derives the stranger's space, never the owner's.
        uint8[64] memory sig = sign(STRANGER, messageOf(STRANGER, SALT, ACTION, DATA));
        vm.expectEmit(address(registry));
        emit Recorded(STRANGER, spaceIdOf(STRANGER), ACTION, NONCE, DATA);
        registry.record(STRANGER, SALT, ACTION, DATA, NONCE, sig);
        assertTrue(spaceIdOf(STRANGER) != spaceIdOf(OWNER));
    }
}
