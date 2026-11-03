# Second-wave check-in: ready to paste

The event's written requirements: current progress; outstanding items; a public GitHub repository with a complete README, development records and an architecture diagram; testnet deployment information (contract address, transaction hash, explorer link if available); and one demo item, a live DApp link or a video of at most three minutes. The logged-in form's exact fields and limits weren't public, so this follows those requirements.

## Project

**Name:** MemDot

**Track:** Modular Cloud & Middleware

**One sentence:** Encrypted storage on Portaldot that keeps itself alive: files and app data are sealed on your device, stored with V3 TransactionStorage, renewed before their 7-day window ends, and shared on your terms.

## Links

- **GitHub:** https://github.com/Blockchain-Oracle/memdot
- **Live app:** https://app.84.46.247.92.sslip.io
- **On-chain registry page:** https://app.84.46.247.92.sslip.io/proof/registry
- **API reference:** https://api.84.46.247.92.sslip.io/docs

## Testnet deployment

- **Network:** Portaldot V3 testnet, chain ID 420420777
- **Contract:** `MemDotRegistry` at `0x24ee3a18c64954d979b7475ccdf58ce4750fb5d1`
- **Deploy transaction:** `0xa536122257fe17de91dd2f85e16f2618f70d5e3b54b0a248854657a814f890d6`, block 279,265
- **Explorer:** https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/279265
- **Other transactions:** the README's [Proof](https://github.com/Blockchain-Oracle/memdot#proof) section lists stores, renewals and registry records, each from a recorded run in `docs/evidence/`.

## Current progress

Working live on V3 today:

- Sign-in with a passkey or a Portaldot wallet (Portaldot Extension, Talisman, SubWallet, polkadot.js), or MetaMask, plus recovery codes. The master key is made on the device and never reaches the server.
- Files and app data encrypted on the device and stored with `TransactionStorage.store`. Small files share one encrypted segment; larger files become chunks plus a sealed manifest.
- A keeper that renews every stored item before its 7-day window ends. A relayer signs for sponsored spaces, and a user's wallet signs and pays for self-signed spaces.
- Sharing with one address and revoking, with key rotation for new writes.
- `MemDotRegistry`, a Solidity contract on Revive. Each record is signed by the owner and checked on-chain with the `sr25519Verify` precompile, and space ids are derived with `hashBlake256`.
- Verify and public proof pages that read directly from a Portaldot node in the browser.
- Agent memory on this storage layer, in two modes. Private runs on the device; Assisted runs on the server for agents that only hold an API key. Remember, search by meaning and keywords, filters, history, forget, restore from the chain, and import from another memory product. Model extraction, search by meaning, reading pictures and an OpenAI-compatible chat endpoint all run on the live service, on a free-tier model with a daily allowance per account.
- Export everything as a decrypted zip and re-import it into a new account, and account deletion that stops every renewal.
- Agents connect themselves: `memdot login` makes a key pair on the machine, the owner chooses spaces in the browser, and the browser wraps those keys to it. A local MCP server decrypts with that key; a hosted one signs in with OAuth and reaches Assisted namespaces only. Revoking stops either on its next call.
- A dashboard on desktop and phone, in light and dark. A CLI with an agent JSON mode. TypeScript and Python SDKs on the same encryption formats, tested against each other, with Python integrations for LangGraph, CrewAI, Strands and the OpenAI Agents SDK. A REST API with OpenAPI, API keys and rate limits.
- Deployed: API, worker, web and Postgres on our own server, with health checks and daily database backups.

## Outstanding items

- Walking real extensions and Touch ID on the live site. Wallet sign-in, MetaMask sign-in and wallet-paid stores have run in the dashboard on a local build against live V3 with test wallets; passkey and recovery-code flows have run end to end
- TypeScript framework adapters and automation nodes
- Docs site and landing page
- The final domain, memdot.xyz, to replace the temporary address
- Rebuilding spaces and objects from registry records (stored items and renewals already rebuild from chain events)
