# MemDot for Zapier

Long-term memory on Portaldot V3, in any Zap.

| Kind | Action | What it does |
|---|---|---|
| Trigger | **New Memory** | Starts a Zap when something new is remembered, for a user, agent or run if you name one |
| Action | **Add Memory** | Remembers text, distilled by a model or as written |
| Action | **Update Memory** | Corrects a memory. The old version stays in its history |
| Action | **Delete Memory** | Forgets a memory |
| Search | **Search Memories** | Finds what's been remembered, by meaning and keyword |
| Search | **Find Memory by ID** | Reads one memory, with Zapier's "not found" path when it's gone |

Search Memories needs a User, Agent or Run ID, or **Search Everyone** set to Yes, so a mapped field that comes back empty can't reach other people's memories. New Memory's settings are chosen once, so leaving its IDs empty means every new memory in the namespace.

## Connect it

Create a key under **API keys** in the [dashboard](https://app.84.46.247.92.sslip.io), and paste it when Zapier asks.

## What it can't do, and why

- **Private namespaces.** Text in a Private namespace is only ever readable on your own device, and a Zap runs on Zapier's servers. Only Assisted namespaces appear, and naming a Private one gets an answer saying so.
- **Files.** Files are encrypted before they leave your device, which would mean giving Zapier a key that opens them. Use the [n8n node](../n8n-nodes-memdot), which runs on your own machine, for files in an automation.

## Timing

Zapier gives each step 30 seconds. Add Memory waits up to 15 of them for the memory to become searchable, then returns how far it got, while MemDot carries on writing it to the chain. A later step can search for it straight away. **Searchable Now** says whether it could, and **Event ID** identifies the write.

## Develop

This folder installs with npm rather than the workspace, because Zapier's build copies its own `node_modules`.

```bash
npm install --ignore-scripts
npx zapier-platform validate
```

Try any action against the real service, with no Zapier account. Put your key in `.env`:

```bash
authData_apiKey=md_your_key
```

```bash
npx zapier-platform invoke auth test --non-interactive
npx zapier-platform invoke create add_memory -i '{"text":"Tomas restocks the clay every second Monday","user_id":"tomas","infer":"false"}' --non-interactive
npx zapier-platform invoke search search_memories -i '{"query":"when is clay restocked?","user_id":"tomas"}' --non-interactive
npx zapier-platform invoke trigger new_memory -i '{"user_id":"tomas"}' --limit 3 --non-interactive
```

To put it in your own Zapier account, log in once with `npx zapier-platform login`, then:

```bash
npx zapier-platform register "MemDot"
npx zapier-platform push
```

It starts private: it appears in your Zap editor, and you share it with an invite link from `npx zapier-platform users:links`.
