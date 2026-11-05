import { MemDot, type Memory, type Namespace, type ScoredMemory } from "@memdot/sdk";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  API_URL,
  type Connection,
  ConnectScreen,
  forgetConnection,
  savedConnection,
} from "./connect";
import { browserEmbedder, listenToModel } from "./embedder";
import "./styles.css";

const LABEL = "Private notes example";
const CLIENT = "private-notes-example";
const NOTES_NAME = "Private notes";
/** Every note here belongs to whoever holds this connection. */
const OWNER = "me";
const SEARCH_RESULTS = 5;

/** A key and an identity from connecting, and a model in this tab for searching by meaning. */
function clientFor({ apiKey, identity }: Connection): MemDot {
  const client = MemDot.create({
    baseUrl: API_URL,
    client: CLIENT,
    credentials: "omit",
    embedder: browserEmbedder,
  });
  client.useAgent({ apiKey, identity });
  return client;
}

/** What MemDot holds for a Private namespace: ask the API directly, with no decryption in the way. */
async function serverView(apiKey: string, namespaceId: string): Promise<unknown> {
  const response = await fetch(`${API_URL}/v1/namespaces/${namespaceId}/private`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  return response.json();
}

function Notes(props: { connection: Connection; onLeave: () => void }) {
  const { connection, onLeave } = props;
  const memdot = useMemo(() => clientFor(connection), [connection]);

  const [namespace, setNamespace] = useState<Namespace | null>(null);
  const [notes, setNotes] = useState<Memory[]>([]);
  const [results, setResults] = useState<ScoredMemory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [model, setModel] = useState<number | null>(null);
  const [view, setView] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => listenToModel(setModel), []);

  const refresh = useCallback(
    async (id: string) => {
      const { results: rows } = await memdot.memories.list({
        namespaceId: id,
        filters: { AND: [{ user_id: OWNER }] },
      });
      setNotes(rows);
    },
    [memdot],
  );

  useEffect(() => {
    (async () => {
      const all = await memdot.memories.namespaces();
      let chosen = all.find((row) => row.mode === "private" && row.name === NOTES_NAME);
      chosen ??= all.find((row) => row.mode === "private");
      if (!chosen) {
        const [space] = await memdot.spaces.list();
        if (!space)
          throw new Error("This connection can't reach any space. Connect again and choose one.");
        chosen = await memdot.memories.createNamespace({
          spaceId: space.id,
          name: NOTES_NAME,
          mode: "private",
        });
      }
      setNamespace(chosen);
      await refresh(chosen.id);
    })().catch((caught: Error) => setError(caught.message));
  }, [memdot, refresh]);

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !namespace) return;
    void act("Encrypting and saving…", async () => {
      // As written: no model reads a note. Embedding and sealing both happen in this tab.
      await memdot.memories.add(text, { userId: OWNER, namespaceId: namespace.id, infer: false });
      setDraft("");
      await refresh(namespace.id);
    });
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    const asked = query.trim();
    if (!namespace) return;
    if (!asked) {
      setResults(null);
      return;
    }
    void act("Searching on this device…", async () => {
      setResults(
        await memdot.memories.search(asked, {
          namespaceId: namespace.id,
          filters: { AND: [{ user_id: OWNER }] },
          topK: SEARCH_RESULTS,
        }),
      );
    });
  };

  const remove = (id: string) =>
    void act("Forgetting…", async () => {
      await memdot.memories.delete(id);
      setResults((current) => current?.filter((row) => row.id !== id) ?? null);
      if (namespace) await refresh(namespace.id);
    });

  const shown: (Memory | ScoredMemory)[] = results ?? notes;

  return (
    <>
      <div className="card">
        <form onSubmit={add} className="row">
          <input
            className="grow field"
            aria-label="New note"
            placeholder="Write something only you should read"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="primary"
            disabled={!namespace || !draft.trim() || Boolean(busy)}
          >
            Save
          </button>
        </form>
        <form onSubmit={search} className="row" style={{ marginTop: 8 }}>
          <input
            className="grow field"
            aria-label="Search notes"
            placeholder="Search by what you meant"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={!namespace || Boolean(busy)}>
            Search
          </button>
        </form>
        {busy ? (
          <p className="quiet" style={{ margin: "8px 0 0" }}>
            {busy}
          </p>
        ) : null}
        {model !== null ? (
          <p className="quiet" style={{ margin: "8px 0 0" }}>
            Downloading the search model, once: {Math.round(model)}%
          </p>
        ) : null}
        {error ? (
          <p className="bad" style={{ margin: "8px 0 0" }}>
            {error}
          </p>
        ) : null}
      </div>

      {results ? (
        <p className="quiet">
          {results.length} found on this device.{" "}
          <button
            type="button"
            onClick={() => {
              setResults(null);
              setQuery("");
            }}
          >
            Show all
          </button>
        </p>
      ) : null}
      {shown.length === 0 && !results ? <p className="quiet">No notes yet.</p> : null}
      {shown.map((note) => (
        <div key={note.id} className="card row" data-note>
          <div className="grow">
            {note.memory}
            {"score" in note ? (
              <div className="quiet">Match: {Math.round(note.score * 100)}%</div>
            ) : null}
          </div>
          <button type="button" disabled={Boolean(busy)} onClick={() => remove(note.id)}>
            Forget
          </button>
        </div>
      ))}

      <div className="row" style={{ marginTop: 16 }}>
        <button
          type="button"
          disabled={!namespace}
          onClick={() =>
            void act("Asking the server…", async () => {
              setView(
                view ? null : await serverView(connection.apiKey, (namespace as Namespace).id),
              );
            })
          }
        >
          {view ? "Hide" : "What the server sees"}
        </button>
        <button
          type="button"
          onClick={() => {
            forgetConnection();
            onLeave();
          }}
        >
          Disconnect
        </button>
      </div>
      {view ? <pre data-server-view>{JSON.stringify(view, null, 2)}</pre> : null}
    </>
  );
}

function App() {
  const [connection, setConnection] = useState<Connection | null>(savedConnection);
  return (
    <main>
      <h1>Private notes</h1>
      <p className="quiet">
        Notes are encrypted and searched by meaning in this tab, with a small model that runs here.
        MemDot stores ciphertext on Portaldot V3 and never sees the text.
      </p>
      {connection ? (
        <Notes connection={connection} onLeave={() => setConnection(null)} />
      ) : (
        <ConnectScreen label={LABEL} client={CLIENT} onConnected={setConnection} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
