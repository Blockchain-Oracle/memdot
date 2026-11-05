# File vault

An encrypted file vault that runs entirely in the browser, with no server of its own. It's one page: [`src/main.tsx`](src/main.tsx) for the vault, and [`src/connect.tsx`](src/connect.tsx) for "Connect with MemDot".

- **Connect:** the page makes a key pair and asks for access. You approve it in your dashboard and choose which spaces it can reach.
- **Upload:** the file is encrypted in the tab, and only ciphertext reaches MemDot. It's on Portaldot V3 once the transaction finalizes.
- **Download:** fetched and decrypted in the tab.
- **Verify:** asks Portaldot V3 directly from your browser, so it doesn't depend on trusting MemDot.
- **What the server sees:** shows exactly what MemDot's API holds about a file.

The part that matters:

```ts
const memdot = MemDot.create({ baseUrl: API_URL, client: "my-app", credentials: "omit" });
memdot.useAgent({ apiKey, identity });

await memdot.files.put(bytes, { spaceId, name: file.name, mime: file.type });
const { data } = await memdot.files.get(id);
const { ok } = await memdot.files.verify(id);
```

`credentials: "omit"` is what lets a page on your own address call the API: it runs on a key, never a dashboard session.

## Run it

From a clone of this repository, with Node 22.12 or newer:

```bash
pnpm install
pnpm --filter "@memdot/example-file-vault..." build
pnpm --filter @memdot/example-file-vault dev
```

Open <http://localhost:5181>, then type the code it shows into your [dashboard](https://app.84.46.247.92.sslip.io/connect). You'll need an account with a space.

## Before using this for real

The connection lives in `sessionStorage`, so it lasts as long as the tab. An identity opens every space it was given, so a page holding one has to be free of scripts you don't control. Give it only the spaces it needs, and revoke it under Agents when you're done.
