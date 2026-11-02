"""Values shared with the TypeScript packages (`packages/config`). Change them there first."""

from __future__ import annotations

__version__ = "0.1.0"

DEFAULT_API_URL = "https://api.84.46.247.92.sslip.io"
PORTALDOT_RPC_URL = "https://test-node-v3.portaldot.dev"
REGISTRY_ADDRESS = "0x24ee3a18c64954d979b7475ccdf58ce4750fb5d1"
EVM_CHAIN_ID = 420_420_777

API_KEY_PREFIX = "md_"
CLIENT_HEADER = "x-memdot-client"
IDEMPOTENCY_HEADER = "idempotency-key"
REQUEST_ID_HEADER = "x-request-id"

#: Ciphertext bytes per stored chunk.
CHUNK_BYTES = 7_000_000
#: Files at or below this size are packed into a shared segment instead of stored alone.
TINY_FILE_BYTES = 65_536
#: CIDv1 prefix for TransactionStorage items: version 1, raw codec, blake2b-256 multihash.
CID_PREFIX = bytes((0x01, 0x55, 0xA0, 0xE4, 0x02, 0x20))
TPOT_DECIMALS = 14
BLOCK_SECONDS = 6
BITSWAP_TIMEOUT_SECONDS = 30
