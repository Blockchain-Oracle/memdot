# n8n-nodes-memdot

MemDot for n8n: long-term agent memory and encrypted files on Portaldot V3.

| Node | What it does |
|---|---|
| **MemDot** | Memories: add, search, list, get, update, delete. Files: upload, download, list, verify, delete. It also works as a tool an AI Agent can call |
| **MemDot Chat Memory** | Plugs into an AI Agent's memory slot. The last turns of a session keep the conversation going, and what's learned about a person comes along in every later session |

## Install

For self-hosted n8n, from your n8n folder:

```bash
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install https://app.84.46.247.92.sslip.io/n8n/n8n-nodes-memdot.tgz --omit=peer --ignore-scripts
```

Then restart n8n. In Docker, that folder is `/home/node/.n8n/nodes`.

n8n Cloud only installs verified nodes. This one isn't verified, because it carries MemDot's encryption code with it, and verified nodes can't have dependencies.

## Connect it

Create a **MemDot API** credential.

- **API Key:** a key from API keys in the [dashboard](https://app.84.46.247.92.sslip.io). That's enough for memories in Assisted namespaces.
- **Agent Identity:** only for files, which are encrypted right there in n8n, so it needs a key of its own. Run this and approve it in your browser:

  ```bash
  memdot login --print-env --label n8n
  ```

  It prints `MEMDOT_API_KEY` and `MEMDOT_AGENT_IDENTITY`. Use both. Nothing is saved on the machine you ran it on, and you can revoke n8n separately under Agents. Anyone who can read this credential can open the spaces you gave that agent, so give it only the ones it needs.

## Try it

Import any workflow from [`workflows`](workflows):

| Workflow | What it shows |
|---|---|
| [`remember-and-search`](workflows/remember-and-search.json) | Remember a fact and find it by meaning, with no model |
| [`agent-with-memory`](workflows/agent-with-memory.json) | An AI Agent with MemDot in its memory slot |
| [`memory-as-a-tool`](workflows/memory-as-a-tool.json) | An AI Agent that searches memory when it decides to |
| [`encrypted-file`](workflows/encrypted-file.json) | Encrypt a file, store it on chain, read it back, verify it, delete it |

For a chat, swap the first two nodes of `agent-with-memory` for a Chat Trigger. The memory node already reads its `sessionId` and `chatInput`.

## How the memory slot works

- **Session ID** names the conversation. Its last turns come back with every message.
- **User ID** names the person. With one, a model distills what each turn taught into memories about them, and a new session finds those by meaning. Without one, only the session's turns are kept.
- A turn is one memory under that session, cut to 4,000 characters per message. A person's facts never mix with transcripts, because turns carry no user ID.
- An empty Session ID is an error, not a shared conversation. If MemDot is down, the agent answers without memory and n8n logs why.

Search and Get Many on the MemDot node need a User, Agent or Run ID, so a mapping that comes back empty can't reach other people's memories. To look through everyone in a namespace, turn on **Across Everyone**.

Every turn is a write on Portaldot V3 and every distilled turn is a model call, both within your account's limits.

## Limits

- **Assisted namespaces only.** A Private namespace searches with a model on your own device, and n8n has nowhere to run one. The node says so when you try. Use the CLI or an SDK for those.
- **Weak models can ignore their notes.** In testing, the smallest Gemini model declined to repeat a "code word" it had been handed, while `gemini-2.5-flash` answered. MemDot delivered the memory either way.

## Develop

```bash
pnpm --filter "n8n-nodes-memdot..." build
pnpm --filter n8n-nodes-memdot journey
```

The journey runs every workflow in a real n8n in Docker, through the same install as above. It takes `MEMDOT_API_KEY`, `MEMDOT_AGENT_IDENTITY`, `MEMDOT_API_URL`, `MEMDOT_SPACE` and `GOOGLE_GENERATIVE_AI_API_KEY`.
