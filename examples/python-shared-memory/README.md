# Agents that share a memory

Three agents that have never met work on one brief. A researcher finds facts, a critic reads them and adds what's missing, and a writer who was told nothing reads both and writes it up. They only communicate through MemDot, and every note stays signed by whoever wrote it.

| Scope | Holds | Who reads it |
|---|---|---|
| `run_id` | The project | Everyone working on it |
| `agent_id` | Who wrote a note | Everyone can see the author, and an agent can keep something under its name alone |

The whole idea is two lines of [`team.py`](team.py):

```python
self.memory.add(text, agent_id=self.name, run_id=self.project, infer=False)
hits = self.memory.search(query, run_id=self.project)
```

## Run it

You need Python 3.10 or newer, and a free [Gemini key](https://aistudio.google.com/apikey). Any other model works by changing `ask`.

```bash
pip install "memdot @ git+https://github.com/Blockchain-Oracle/memdot.git#subdirectory=python/memdot"
memdot login
export GEMINI_API_KEY=your-key
python team.py "opening a small neighbourhood bakery"
```

It cleans up its memories when it finishes. Without `memdot login`, set `MEMDOT_API_KEY` to a key from the dashboard. Set `MEMDOT_NAMESPACE` to choose where memories go. In a Private namespace, also install `memdot[local]` so search works by meaning on your machine.

## Why not one process?

They run in one script so it's easy to read. Nothing in it depends on that: each agent makes its own client and only knows the project's name, so they could be on different machines, in different languages, or days apart.

The Python framework integrations work the same way: `memdot.integrations.crewai`, `strands`, `langgraph` and `openai_agents`.
