# MemDot skills

Teach your coding agent MemDot. Install one, or all of them:

```bash
npx skills add Blockchain-Oracle/memdot --skill memdot
```

| Skill | Kind | What it does |
|---|---|---|
| [`memdot`](memdot) | Reference | The SDKs, REST API, MCP and framework adapters, and how to choose between Private and Assisted |
| [`memdot-cli`](memdot-cli) | Reference | Every `memdot` command, with its JSON envelope and exit codes |
| [`memdot-integrate`](memdot-integrate) | Runs on request | Adds memory to an existing project: a failing test first, then the wiring, on a branch |
| [`memdot-test-integration`](memdot-test-integration) | Runs on request | Checks an integration against the real service and gives it a scorecard. Changes nothing in the repository |
| [`memdot-migrate-from-mem0`](memdot-migrate-from-mem0) | Runs on request | Brings memories and code over from Mem0, with matching counts |

These teach an agent to build with MemDot. To give your coding agent a memory of its own instead, install the [agent plugin](../integrations).
