// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ISystem, SYSTEM_ADDR} from "./ISystem.sol";

/// @title MemDot registry
/// @notice Who owns what MemDot stores on Portaldot V3 TransactionStorage, and who may read it.
/// Bytes never reach this contract: records reference blake2b-256 content hashes (a CID is a
/// fixed prefix plus that hash). Owners are Substrate AccountId32s. An owner either calls
/// directly (Revive maps their account) or signs the action, and a relayer submits it; the
/// signature is checked on-chain with the sr25519 precompile.
/// @dev State is kept small because Revive charges a storage deposit per item and per byte.
/// Objects are recorded as events only; the MemDot indexer rebuilds them from logs.
contract MemDotRegistry {
    ISystem private constant SYSTEM = ISystem(SYSTEM_ADDR);
    string private constant DOMAIN = "memdot/registry/v1";

    enum SpaceMode {
        Sponsored,
        SelfSigned
    }

    enum ObjectKind {
        File,
        Manifest,
        Segment,
        IndexSnapshot,
        KeyBundle,
        GrantKey
    }

    enum Scope {
        Read,
        ReadWrite
    }

    struct Account {
        bytes32 encryptionKey;
        bytes32 keyBundleHash;
        uint32 keyVersion;
        bool active;
    }

    struct Space {
        bytes32 owner;
        uint32 keyEpoch;
        SpaceMode mode;
        bool active;
    }

    mapping(bytes32 owner => Account) public accounts;
    mapping(bytes32 owner => uint64) public nonces;
    mapping(bytes32 spaceId => Space) public spaces;
    /// @dev 0 = no grant or revoked; otherwise expiry as unix seconds (type(uint64).max = none).
    mapping(bytes32 grantId => uint64) public grantExpiry;
    mapping(bytes32 grantId => bytes32) public grantSpace;
    mapping(bytes32 owner => mapping(bytes32 agentKey => bool)) public agents;

    event KeyRegistered(
        bytes32 indexed owner, bytes32 encryptionKey, bytes32 keyBundleHash, uint32 keyVersion
    );
    event AccountDeleted(bytes32 indexed owner);
    event SpaceCreated(bytes32 indexed spaceId, bytes32 indexed owner, SpaceMode mode);
    event SpaceDeleted(bytes32 indexed spaceId);
    event SpaceKeyRotated(bytes32 indexed spaceId, uint32 keyEpoch);
    event ObjectAdded(
        bytes32 indexed spaceId, bytes32 indexed contentHash, ObjectKind kind, uint64 size
    );
    event ObjectTombstoned(bytes32 indexed spaceId, bytes32 indexed contentHash);
    event GrantCreated(
        bytes32 indexed grantId,
        bytes32 indexed spaceId,
        bytes32 indexed grantee,
        bytes32 objectHash,
        Scope scope,
        uint64 expiresAt,
        bytes32 wrappedKeyHash
    );
    event GrantRevoked(bytes32 indexed grantId);
    event AgentRegistered(bytes32 indexed owner, bytes32 indexed agentKey);
    event AgentRevoked(bytes32 indexed owner, bytes32 indexed agentKey);

    error NotAuthorized();
    error BadNonce(uint64 expected);
    error AccountInactive();
    error SpaceExists();
    error UnknownSpace();
    error NotSpaceOwner();
    error LengthMismatch();
    error UnknownGrant();

    // ----- accounts -----

    /// @notice Registers or rotates the owner's X25519 sharing key and key-bundle reference.
    function registerKey(
        bytes32 owner,
        bytes32 encryptionKey,
        bytes32 keyBundleHash,
        uint64 nonce,
        uint8[64] calldata sig
    ) external {
        _authorize(owner, keccak256(abi.encode("registerKey", encryptionKey, keyBundleHash)), nonce, sig);
        Account storage account = accounts[owner];
        account.encryptionKey = encryptionKey;
        account.keyBundleHash = keyBundleHash;
        account.keyVersion += 1;
        account.active = true;
        emit KeyRegistered(owner, encryptionKey, keyBundleHash, account.keyVersion);
    }

    /// @notice Marks the account deleted. Off-chain, the keeper stops renewing its data.
    function deleteAccount(bytes32 owner, uint64 nonce, uint8[64] calldata sig) external {
        _authorize(owner, keccak256(abi.encode("deleteAccount")), nonce, sig);
        accounts[owner].active = false;
        emit AccountDeleted(owner);
    }

    // ----- spaces -----

    function createSpace(
        bytes32 owner,
        bytes32 salt,
        SpaceMode mode,
        uint64 nonce,
        uint8[64] calldata sig
    ) external returns (bytes32 spaceId) {
        _authorize(owner, keccak256(abi.encode("createSpace", salt, mode)), nonce, sig);
        if (!accounts[owner].active) revert AccountInactive();
        spaceId = SYSTEM.hashBlake256(abi.encodePacked(owner, salt));
        if (spaces[spaceId].owner != bytes32(0)) revert SpaceExists();
        spaces[spaceId] = Space({owner: owner, keyEpoch: 0, mode: mode, active: true});
        emit SpaceCreated(spaceId, owner, mode);
    }

    function deleteSpace(bytes32 owner, bytes32 spaceId, uint64 nonce, uint8[64] calldata sig)
        external
    {
        _authorize(owner, keccak256(abi.encode("deleteSpace", spaceId)), nonce, sig);
        _requireOwner(owner, spaceId).active = false;
        emit SpaceDeleted(spaceId);
    }

    // ----- objects (events only) -----

    function addObjects(
        bytes32 owner,
        bytes32 spaceId,
        bytes32[] calldata contentHashes,
        ObjectKind[] calldata kinds,
        uint64[] calldata sizes,
        uint64 nonce,
        uint8[64] calldata sig
    ) external {
        if (contentHashes.length != kinds.length || kinds.length != sizes.length) {
            revert LengthMismatch();
        }
        _authorize(
            owner, keccak256(abi.encode("addObjects", spaceId, contentHashes, kinds, sizes)), nonce, sig
        );
        _requireOwner(owner, spaceId);
        for (uint256 i = 0; i < contentHashes.length; i++) {
            emit ObjectAdded(spaceId, contentHashes[i], kinds[i], sizes[i]);
        }
    }

    function tombstoneObjects(
        bytes32 owner,
        bytes32 spaceId,
        bytes32[] calldata contentHashes,
        uint64 nonce,
        uint8[64] calldata sig
    ) external {
        _authorize(owner, keccak256(abi.encode("tombstoneObjects", spaceId, contentHashes)), nonce, sig);
        _requireOwner(owner, spaceId);
        for (uint256 i = 0; i < contentHashes.length; i++) {
            emit ObjectTombstoned(spaceId, contentHashes[i]);
        }
    }

    // ----- grants -----

    /// @notice Shares a whole space (objectHash = 0) or one object with an account or agent.
    /// @param wrappedKeyHash content hash of the key (or manifest) sealed to the grantee.
    function grant(
        bytes32 owner,
        bytes32 spaceId,
        bytes32 objectHash,
        bytes32 grantee,
        Scope scope,
        uint64 expiresAt,
        bytes32 wrappedKeyHash,
        uint64 nonce,
        uint8[64] calldata sig
    ) external returns (bytes32 grantId) {
        _authorize(
            owner,
            keccak256(
                abi.encode("grant", spaceId, objectHash, grantee, scope, expiresAt, wrappedKeyHash)
            ),
            nonce,
            sig
        );
        _requireOwner(owner, spaceId);
        grantId = SYSTEM.hashBlake256(abi.encodePacked(owner, spaceId, objectHash, grantee, nonce));
        grantExpiry[grantId] = expiresAt == 0 ? type(uint64).max : expiresAt;
        grantSpace[grantId] = spaceId;
        emit GrantCreated(grantId, spaceId, grantee, objectHash, scope, expiresAt, wrappedKeyHash);
    }

    /// @notice Stops future access. The space key moves to a new epoch for new writes; anything
    /// the grantee already decrypted cannot be taken back.
    function revokeGrant(bytes32 owner, bytes32 grantId, uint64 nonce, uint8[64] calldata sig)
        external
    {
        _authorize(owner, keccak256(abi.encode("revokeGrant", grantId)), nonce, sig);
        bytes32 spaceId = grantSpace[grantId];
        if (spaceId == bytes32(0) || grantExpiry[grantId] == 0) revert UnknownGrant();
        Space storage space = _requireOwner(owner, spaceId);
        grantExpiry[grantId] = 0;
        space.keyEpoch += 1;
        emit GrantRevoked(grantId);
        emit SpaceKeyRotated(spaceId, space.keyEpoch);
    }

    function isGrantActive(bytes32 grantId) external view returns (bool) {
        uint64 expiry = grantExpiry[grantId];
        return expiry != 0 && expiry > block.timestamp;
    }

    // ----- agents -----

    function registerAgent(bytes32 owner, bytes32 agentKey, uint64 nonce, uint8[64] calldata sig)
        external
    {
        _authorize(owner, keccak256(abi.encode("registerAgent", agentKey)), nonce, sig);
        agents[owner][agentKey] = true;
        emit AgentRegistered(owner, agentKey);
    }

    function revokeAgent(bytes32 owner, bytes32 agentKey, uint64 nonce, uint8[64] calldata sig)
        external
    {
        _authorize(owner, keccak256(abi.encode("revokeAgent", agentKey)), nonce, sig);
        agents[owner][agentKey] = false;
        emit AgentRevoked(owner, agentKey);
    }

    // ----- authorization -----

    /// @notice The exact bytes an owner signs to authorize `actionHash` at `nonce`.
    function signingMessage(bytes32 owner, uint64 nonce, bytes32 actionHash)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(DOMAIN, block.chainid, address(this), owner, nonce, actionHash);
    }

    function _authorize(bytes32 owner, bytes32 actionHash, uint64 nonce, uint8[64] calldata sig)
        internal
    {
        uint64 expected = nonces[owner];
        if (nonce != expected) revert BadNonce(expected);
        nonces[owner] = expected + 1;
        if (_callerAccount() == owner) return;

        bytes memory message = signingMessage(owner, nonce, actionHash);
        if (SYSTEM.sr25519Verify(sig, message, owner)) return;
        // Browser wallets sign raw bytes wrapped as <Bytes>…</Bytes>.
        if (SYSTEM.sr25519Verify(sig, abi.encodePacked("<Bytes>", message, "</Bytes>"), owner)) return;
        revert NotAuthorized();
    }

    function _callerAccount() internal view returns (bytes32 account) {
        bytes memory id = SYSTEM.toAccountId(msg.sender);
        if (id.length != 32) return bytes32(0);
        assembly {
            account := mload(add(id, 32))
        }
    }

    function _requireOwner(bytes32 owner, bytes32 spaceId) internal view returns (Space storage) {
        Space storage space = spaces[spaceId];
        if (space.owner == bytes32(0) || !space.active) revert UnknownSpace();
        if (space.owner != owner) revert NotSpaceOwner();
        return space;
    }
}
