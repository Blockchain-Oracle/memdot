// Portaldot V3 testnet facts MemDot depends on. Values were read from the live chain on
// 2026-10-29 (see docs/evidence and context notes); change them only after re-measuring.

export const PORTALDOT_WSS = "wss://test-node-v3.portaldot.dev";
export const PORTALDOT_EVM_RPC = "https://test-evm-rpc-v3.portaldot.dev";
export const EVM_CHAIN_ID = 420_420_777;
export const SS58_PREFIX = 42;

export const TPOT_DECIMALS = 14;
export const EVM_DECIMALS = 18;
/** Revive's NativeToEthRatio: 1 planck (14 decimals) = 10,000 wei-units (18 decimals). */
export const NATIVE_TO_ETH_RATIO = 10_000n;
/** pallet-revive maps an H160 to an AccountId32 by appending twelve 0xEE bytes. */
export const EVM_ACCOUNT_SUFFIX = "ee".repeat(12);

export const BLOCK_MS = 6_000;

/** TransactionStorage keeps an item for this many blocks (7 days at 6 s) unless it is renewed. */
export const RETENTION_BLOCKS = 100_800;
/** The keeper renews once an item has used this share of its retention window. */
export const RENEW_AT_FRACTION = 0.8;
/** Items past this share of the window raise an ops alert. */
export const ALERT_AT_FRACTION = 0.9;

/** Pallet limit per `store` call. */
export const MAX_TRANSACTION_BYTES = 8_388_608;
/** Pallet limit of indexed transactions (stores + renews) per block. */
export const MAX_BLOCK_TRANSACTIONS = 512;
/**
 * Ciphertext bytes per stored chunk. Extrinsics travel hex-encoded and the node's RPC request
 * cap is 15 MB, so ~7.5 MiB is the real ceiling; 7,000,000 leaves room for SCALE and signature.
 */
export const CHUNK_BYTES = 7_000_000;

/** CIDv1 prefix for TransactionStorage items: version 1, raw codec 0x55, blake2b-256 multihash. */
export const CID_PREFIX = Uint8Array.of(0x01, 0x55, 0xa0, 0xe4, 0x02, 0x20);

/** `store` fee model measured on 2026-10-29 (fee multiplier ≈ 0.553): base + per byte. */
export const STORE_FEE_BASE_PLANCK = 1_220_582_728_631n;
export const STORE_FEE_PER_BYTE_PLANCK = 10_000_000_000n;
/** `renew` costs the same regardless of item size (measured 2026-10-29). */
export const RENEW_FEE_PLANCK = 1_170_611_339_764n;
