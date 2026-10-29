# Office Hours — 2026-10-30 12:00 UTC

Application for the Portaldot Hacker House 2026 mentor session. Written 2026-10-29.

## Project

**MemDot**: storage and long-term memory for AI agents and apps on Portaldot V3. Agents remember and recall across sessions; data is encrypted before it leaves the client, stored and renewed on V3, and its ownership and access grants live in an on-chain registry. Developers reach it through one SDK, a REST API, a CLI, an MCP server for agents, and a dashboard with API keys. Track: Modular Cloud & Middleware.

Repository: https://github.com/Blockchain-Oracle/memdot

## Progress, stated plainly

| Area | State |
|---|---|
| Research | Done: event rules and the V3 network's storage and contract surfaces. |
| V3 runtime probe | Done: [`scripts/v3-probe.mjs`](../scripts/v3-probe.mjs) reads live metadata for `TransactionStorage`, `Revive` and `Contracts`. Output committed in [`docs/evidence/`](evidence). |
| Brand | Done: logo mark and banner in [`assets/brand/`](../assets/brand). |
| Architecture | Candidate only (see the [README](../README.md#candidate-architecture-not-final)). Three decisions are open, and they depend on the answers below. |
| Testnet deployment | **None yet, on purpose.** No signed transactions so far. We want the storage path settled before deploying anything. Test tPOT is being requested through a support ticket. |
| Demo | None yet. |

## What the probe found (2026-10-29, block ~236,350)

- `TransactionStorage`: calls `store`, `renew`, `check_proof`. Max 8,388,608 bytes per transaction, 512 per block. `byteFee` 10, `entryFee` 1,000. `retentionPeriod` 100,800 blocks, which is **7 days** at the 6,000 ms block time. There is an `authorizations` storage map, but no authorize call in the metadata. `proofChecked` read `false`.
- `Revive`: EVM bytecode allowed, chain ID 420420777, `AutoMap` on, `nativeToEthRatio` 10,000, `ethSubstrateCall` and `map_account` present.
- `Contracts`: API version 4, pallet version 16, max code length 125,952 bytes.

## Questions for the mentors

### 1. Reading stored bytes back
After `TransactionStorage.store`, how should an application retrieve the bytes from the hosted network (`wss://test-node-v3.portaldot.dev`)? Does the node keep indexed transactions, run an IPFS/bitswap server, or expose an RPC to fetch by content hash? This decides whether MemDot can use native storage at all.

### 2. Retention and renewal
`retentionPeriod` is 100,800 blocks (7 days). Is that the intended value for mainnet? Is `renew` the expected way to keep data long-term, and how does its cost compare with a fresh `store`? Should apps run a renewal keeper, or is something planned at the protocol level?

### 3. Authorization and fees
The pallet has an `authorizations` map but exposes no authorize call. Does `store` require prior authorization on V3, or is it gated only by `byteFee` and `entryFee`? Are storage proofs being submitted on this testnet (`proofChecked` was `false` when we read it)?

### 4. Which contract runtime for a long-lived registry
The registry holds owner, namespace, content hash and access grants per memory. Does the team recommend Solidity on `Revive` or ink! on `Contracts` for something meant to reach mainnet? Can a `Revive` contract reference or verify a `TransactionStorage` entry, for example through `ethSubstrateCall` or a precompile?

### 5. One identity across native and EVM accounts
For a web app, what is the recommended flow to give one user a single identity across an SS58 account and its H160 mapping (`map_account`, `AutoMap`), and to fund the mapped EVM account given the 10,000 native-to-ETH ratio?

### 6. Source and roadmap
Is the V3 runtime source, or at least its `TransactionStorage` and `Revive` configuration, published anywhere? Is `TransactionStorage` planned for mainnet?

## What we will do with the answers

1. If native retrieval works: memories are stored with `store`, a keeper renews them before the 7-day limit, and the registry holds ownership and grants.
2. If it does not: bytes go to an external store, and V3 holds only the content hash, ownership and grants. The README will state where the bytes actually live.
3. Either way, the first deliverable is a signed `store` → read back → `renew` (or anchor) round trip with transaction hashes, before the 2026-11-04 check-in.
