---
name: memdot-migrate-from-mem0
description: >
  Move a project from Mem0 to MemDot: export the memories, import them with matching counts, map the
  code, and choose Private or Assisted. Plans first, and changes code only once the person agrees.
  TRIGGER when: the user says "migrate from mem0", "move off mem0", "import my mem0 memories", or the
  project imports mem0 or mem0ai and they want MemDot.
  DO NOT TRIGGER when: the project has no Mem0 in it (use memdot-integrate).
license: Apache-2.0
metadata:
  author: Blockchain-Oracle
  version: 0.1.0
  category: ai-memory
---

# Migrate from Mem0

Don't turn anything off until the counts match and the app works on MemDot. The old store stays untouched by every step here.

## 1. Look and plan

Find every use of Mem0: `grep -rnE "mem0|MemoryClient|from mem0|mem0ai" --include="*.py" --include="*.ts" --include="*.js" .`. Note which product it is (the hosted client or the open-source library), the IDs used (`user_id`, `agent_id`, `run_id`, `app_id`), any metadata the app filters on, and whether it uses graph memory, webhooks or custom categories.

Write `.memdot-migration/plan.md` with the mapping and what doesn't carry over ([references/api-mapping.md](references/api-mapping.md)), and **stop for the person's agreement** before changing code.

## 2. Choose a mode

This is the one new decision. Mem0's hosted platform works like **Assisted**: its server reads text to extract and search. **Private** is new: nothing readable leaves the device, which needs an agent identity on the machine and runs extraction with your own model key. See the `memdot` skill. Create the namespace:

```bash
memdot namespace create my-app --mode assisted --space <id>
```

## 3. Export

The hosted client pages through `get_all`, which is the simplest export and keeps IDs and metadata. Export one scope at a time, because it requires filters:

```python
import json
from mem0 import MemoryClient

client = MemoryClient()
rows, page = [], 1
while True:
    batch = client.get_all(filters={"user_id": "alex"}, page=page, page_size=200)
    rows += batch["results"]
    if not batch.get("next"):
        break
    page += 1
json.dump(rows, open("mem0-export.json", "w"))
```

Run it for each user, agent and run. The dashboard's export also works, and so does a dump from the open-source library's `get_all`. The importer reads each of those shapes: a bare list, or one under `results` or `memories`, with the text in `memory`, `text`, `content` or `data.memory`.

Export files hold what people said. Keep them out of the repository, and delete them afterwards.

## 4. Import, and check the counts

```bash
memdot import mem0-export.json -n <namespace> --source mem0
memdot --agent list -n <namespace> -u alex
```

The report gives what was imported, what was skipped (rows with no text) and what was already there. Imported memories are stored as written, so no model runs over them. Importing twice doesn't duplicate.

**Compare counts per user against the export.** Then search a few real questions on both and compare what comes back. Scores won't match, since the models differ. The right memories should still come back.

Mind the quota: every memory is stored on chain. `memdot usage` shows what's left. In a sponsored space, a large export may need your own wallet paying (a self-signed space) or a smaller first batch.

## 5. Change the code

Follow [references/api-mapping.md](references/api-mapping.md). For Python, the verbs are the same on the client, so most changes are the import and the constructor. Results still answer to `hit["memory"]`. In TypeScript, move to `@memdot/sdk`, or to an adapter if the project uses a framework.

## 6. Check it

Run the `memdot-test-integration` skill. Writing new memories, recall through the app, and users staying apart all have to pass.

## 7. Cut over

Tell the person it's ready, and leave switching off the old service to them. Delete `mem0-export.json`. Then remove the old dependency and its API key from the environment.
