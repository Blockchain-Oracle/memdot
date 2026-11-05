# REST API

Base: `https://api.84.46.247.92.sslip.io`. Reference: [`/docs`](https://api.84.46.247.92.sslip.io/docs). Schema: [`/openapi.json`](https://api.84.46.247.92.sslip.io/openapi.json). Always check the schema for exact fields.

```bash
curl -s https://api.84.46.247.92.sslip.io/v1/memories/search \
  -H "authorization: Bearer $MEMDOT_API_KEY" \
  -H "content-type: application/json" \
  -d '{"query":"what does Priya drink?","filters":{"AND":[{"user_id":"priya"}]},"top_k":5}'
```

| Call | Path |
|---|---|
| Add | `POST /v1/memories` with `messages`, `user_id`, `agent_id`, `run_id`, `namespace_id`, `infer`, `metadata`. Returns `event_id`. An `idempotency-key` header makes a retry safe |
| Search | `POST /v1/memories/search` |
| List | `POST /v1/memories/list`, newest first, with `page_size` and `cursor` |
| One | `GET`, `PUT`, `DELETE /v1/memories/{id}` |
| Everything in a scope | `DELETE /v1/memories?user_id=…` |
| History | `GET /v1/memories/{id}/history` |
| Follow a write | `GET /v1/memories/events/{id}`. `indexed` means searchable, `status: SUCCEEDED` means finalized on chain, and `tx_hash` is the proof |
| Namespaces | `GET /v1/namespaces` |
| Chat that remembers | `POST /v1/chat/completions`, OpenAI's shape plus `user_id` (or `agent_id`, `run_id`) and `namespace_id` |
| Usage | `GET /v1/usage` |

Errors look like `{ "error": { "code", "message", "requestId" } }`. `code` is stable. A key that was revoked answers 401, and being over a limit answers 429.

The server can't read Private namespaces, so memory routes refuse them with `PRIVATE_NAMESPACE`. Files are ciphertext to this API, so use an SDK for those.
