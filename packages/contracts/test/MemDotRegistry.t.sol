// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SYSTEM_ADDR} from "../src/ISystem.sol";
import {MemDotRegistry} from "../src/MemDotRegistry.sol";

/// Stand-in for Portaldot's System precompile. The real sr25519Verify and hashBlake256 were
/// checked live on V3 (scripts/check-precompiles.ts); here a "signature" is keccak(pk, message).
contract MockSystem {
    mapping(address => bytes32) public accountOf;

    function setAccount(address evm, bytes32 id) external {
        accountOf[evm] = id;
    }

    function hashBlake256(bytes memory input) external pure returns (bytes32) {
        return keccak256(input);
    }

    function toAccountId(address evm) external view returns (bytes memory) {
        bytes32 id = accountOf[evm];
        if (id == bytes32(0)) id = bytes32(abi.encodePacked(evm, bytes12(0xeeeeeeeeeeeeeeeeeeeeeeee)));
        return abi.encodePacked(id);
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
    MockSystem system;

    bytes32 constant OWNER = keccak256("owner");
    bytes32 constant STRANGER = keccak256("stranger");
    address constant RELAYER = address(0xBEEF);
    address constant OWNER_EVM = address(0xA11CE);
    uint8[64] NO_SIG;

    function setUp() public {
        vm.etch(SYSTEM_ADDR, address(new MockSystem()).code);
        system = MockSystem(SYSTEM_ADDR);
        system.setAccount(OWNER_EVM, OWNER);
        registry = new MemDotRegistry();
    }

    function sign(bytes32 pk, bytes32 actionHash, uint64 nonce) internal view returns (uint8[64] memory sig) {
        bytes32 digest = keccak256(abi.encodePacked(pk, registry.signingMessage(pk, nonce, actionHash)));
        for (uint256 i = 0; i < 32; i++) sig[i] = uint8(digest[i]);
    }

    function registerOwnerDirect() internal {
        vm.prank(OWNER_EVM);
        registry.registerKey(OWNER, bytes32("x25519"), bytes32("bundle"), 0, NO_SIG);
    }

    function createSpaceViaRelayer(bytes32 salt) internal returns (bytes32) {
        uint64 nonce = registry.nonces(OWNER);
        bytes32 action = keccak256(abi.encode("createSpace", salt, MemDotRegistry.SpaceMode.Sponsored));
        uint8[64] memory sig = sign(OWNER, action, nonce);
        vm.prank(RELAYER);
        return registry.createSpace(OWNER, salt, MemDotRegistry.SpaceMode.Sponsored, nonce, sig);
    }

    function test_ownerCallsDirectlyWithoutSignature() public {
        registerOwnerDirect();
        (bytes32 key,, uint32 version, bool active) = registry.accounts(OWNER);
        assertEq(key, bytes32("x25519"));
        assertEq(version, 1);
        assertTrue(active);
        assertEq(registry.nonces(OWNER), 1);
    }

    function test_relayerNeedsTheOwnersSignature() public {
        registerOwnerDirect();
        bytes32 spaceId = createSpaceViaRelayer("s1");
        (bytes32 owner,,, bool active) = registry.spaces(spaceId);
        assertEq(owner, OWNER);
        assertTrue(active);

        // Same action signed by someone else is rejected.
        uint64 nonce = registry.nonces(OWNER);
        bytes32 action = keccak256(abi.encode("deleteSpace", spaceId));
        uint8[64] memory forged = sign(STRANGER, action, nonce);
        vm.prank(RELAYER);
        vm.expectRevert(MemDotRegistry.NotAuthorized.selector);
        registry.deleteSpace(OWNER, spaceId, nonce, forged);
    }

    function test_replayedOrSkippedNoncesAreRejected() public {
        registerOwnerDirect();
        bytes32 salt = "s1";
        bytes32 action = keccak256(abi.encode("createSpace", salt, MemDotRegistry.SpaceMode.Sponsored));
        uint8[64] memory sig = sign(OWNER, action, 1);
        vm.prank(RELAYER);
        registry.createSpace(OWNER, salt, MemDotRegistry.SpaceMode.Sponsored, 1, sig);

        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(MemDotRegistry.BadNonce.selector, uint64(2)));
        registry.createSpace(OWNER, salt, MemDotRegistry.SpaceMode.Sponsored, 1, sig);
    }

    function test_walletWrappedSignaturesAreAccepted() public {
        registerOwnerDirect();
        bytes32 salt = "wrapped";
        bytes32 action = keccak256(abi.encode("createSpace", salt, MemDotRegistry.SpaceMode.SelfSigned));
        bytes memory wrapped =
            abi.encodePacked("<Bytes>", registry.signingMessage(OWNER, 1, action), "</Bytes>");
        bytes32 digest = keccak256(abi.encodePacked(OWNER, wrapped));
        uint8[64] memory sig;
        for (uint256 i = 0; i < 32; i++) sig[i] = uint8(digest[i]);
        vm.prank(RELAYER);
        registry.createSpace(OWNER, salt, MemDotRegistry.SpaceMode.SelfSigned, 1, sig);
    }

    function test_objectsAreEventsAndOnlyTheOwnerAddsThem() public {
        registerOwnerDirect();
        bytes32 spaceId = createSpaceViaRelayer("s1");
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = keccak256("chunk-0");
        hashes[1] = keccak256("manifest");
        MemDotRegistry.ObjectKind[] memory kinds = new MemDotRegistry.ObjectKind[](2);
        kinds[0] = MemDotRegistry.ObjectKind.File;
        kinds[1] = MemDotRegistry.ObjectKind.Manifest;
        uint64[] memory sizes = new uint64[](2);
        sizes[0] = 7_000_000;
        sizes[1] = 512;

        vm.expectEmit(true, true, false, true);
        emit MemDotRegistry.ObjectAdded(spaceId, hashes[0], kinds[0], sizes[0]);
        vm.prank(OWNER_EVM);
        registry.addObjects(OWNER, spaceId, hashes, kinds, sizes, 2, NO_SIG);

        system.setAccount(address(0xBAD), STRANGER);
        vm.prank(address(0xBAD));
        vm.expectRevert(MemDotRegistry.NotSpaceOwner.selector);
        registry.tombstoneObjects(STRANGER, spaceId, hashes, 0, NO_SIG);
    }

    function test_revokeStopsTheGrantAndRotatesTheSpaceKey() public {
        registerOwnerDirect();
        bytes32 spaceId = createSpaceViaRelayer("s1");
        vm.prank(OWNER_EVM);
        bytes32 grantId = registry.grant(
            OWNER, spaceId, bytes32(0), STRANGER, MemDotRegistry.Scope.Read, 0, keccak256("wrapped"), 2, NO_SIG
        );
        assertTrue(registry.isGrantActive(grantId));

        vm.prank(OWNER_EVM);
        registry.revokeGrant(OWNER, grantId, 3, NO_SIG);
        assertFalse(registry.isGrantActive(grantId));
        (, uint32 epoch,,) = registry.spaces(spaceId);
        assertEq(epoch, 1);

        vm.prank(OWNER_EVM);
        vm.expectRevert(MemDotRegistry.UnknownGrant.selector);
        registry.revokeGrant(OWNER, grantId, 4, NO_SIG);
    }

    function test_grantsExpire() public {
        registerOwnerDirect();
        bytes32 spaceId = createSpaceViaRelayer("s1");
        vm.prank(OWNER_EVM);
        bytes32 grantId = registry.grant(
            OWNER,
            spaceId,
            keccak256("one-file"),
            STRANGER,
            MemDotRegistry.Scope.Read,
            uint64(block.timestamp + 1 days),
            keccak256("wrapped"),
            2,
            NO_SIG
        );
        assertTrue(registry.isGrantActive(grantId));
        vm.warp(block.timestamp + 2 days);
        assertFalse(registry.isGrantActive(grantId));
    }

    function test_agentsAndAccountDeletion() public {
        registerOwnerDirect();
        vm.startPrank(OWNER_EVM);
        registry.registerAgent(OWNER, keccak256("agent"), 1, NO_SIG);
        assertTrue(registry.agents(OWNER, keccak256("agent")));
        registry.revokeAgent(OWNER, keccak256("agent"), 2, NO_SIG);
        assertFalse(registry.agents(OWNER, keccak256("agent")));
        registry.deleteAccount(OWNER, 3, NO_SIG);
        vm.stopPrank();
        (,,, bool active) = registry.accounts(OWNER);
        assertFalse(active);

        uint64 nonce = registry.nonces(OWNER);
        bytes32 action = keccak256(abi.encode("createSpace", bytes32("late"), MemDotRegistry.SpaceMode.Sponsored));
        uint8[64] memory sig = sign(OWNER, action, nonce);
        vm.prank(RELAYER);
        vm.expectRevert(MemDotRegistry.AccountInactive.selector);
        registry.createSpace(OWNER, "late", MemDotRegistry.SpaceMode.Sponsored, nonce, sig);
    }
}
