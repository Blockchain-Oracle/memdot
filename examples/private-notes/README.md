# Private notes

Notes you can search by meaning, where the server never sees the text. It runs entirely in the browser, with no server of its own, in one page: [`src/main.tsx`](src/main.tsx).

- **Saving:** the note is embedded and encrypted in the tab. MemDot gets ciphertext, which goes on Portaldot V3.
- **Searching:** a small model (`all-MiniLM-L6-v2`, about 23 MB, downloaded once) runs in a Web Worker in the tab, over an index that lives on your device. "Where do I keep the spare key?" finds "the key is under the blue tin".
- **What the server sees:** shows exactly what MemDot's API holds for this namespace: IDs and versions, and no text.

The whole of it is the same two calls as any other namespace:

```ts
const memdot = MemDot.create({ baseUrl: API_URL, client: "my-app", credentials: "omit", embedder: browserEmbedder });
memdot.useAgent({ apiKey, identity });

await memdot.memories.add(text, { userId: "me", namespaceId, infer: false });
const hits = await memdot.memories.search(query, { namespaceId, filters: { AND: [{ user_id: "me" }] } });
```

A namespace's mode decides where the work happens. In a Private namespace, these calls run here. `infer: false` keeps a note as you wrote it. To have facts distilled instead, set your own model with `memdot.memories.setPrivateModel`, and that call goes from this tab to your model provider, never through MemDot.

## Run it

From a clone of this repository, with Node 22.12 or newer:

```bash
pnpm install
pnpm --filter "@memdot/example-private-notes..." build
pnpm --filter @memdot/example-private-notes dev
```

Open <http://localhost:5182>, then type the code it shows into your [dashboard](https://app.84.46.247.92.sslip.io/connect). It uses a Private namespace in a space you chose, and creates one if there isn't any.

## Before using this for real

The connection lives in `sessionStorage`, so it lasts as long as the tab. An identity opens every space it was given, so a page holding one has to be free of scripts you don't control.
