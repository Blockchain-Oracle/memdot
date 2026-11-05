import { type ListedFile, MemDot } from "@memdot/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  API_URL,
  type Connection,
  ConnectScreen,
  forgetConnection,
  savedConnection,
} from "./connect";
import "./styles.css";

const LABEL = "File vault example";
const CLIENT = "file-vault-example";

/** A key and an identity from connecting. `credentials: "omit"` is what lets a page on any address call the API. */
function clientFor({ apiKey, identity }: Connection): MemDot {
  const client = MemDot.create({ baseUrl: API_URL, client: CLIENT, credentials: "omit" });
  client.useAgent({ apiKey, identity });
  return client;
}

function download(data: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data.slice()], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** What MemDot actually holds about a file: ask the API directly, with no decryption in the way. */
async function serverView(apiKey: string, id: string): Promise<unknown> {
  const response = await fetch(`${API_URL}/v1/objects/${id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const { encryptedMeta, cid, sizeBytes, status } = (await response.json()) as Record<
    string,
    unknown
  >;
  return { encryptedMeta, cid, sizeBytes, status };
}

function FileRow(props: { file: ListedFile; memdot: MemDot; apiKey: string; onGone: () => void }) {
  const { file, memdot, apiKey, onGone } = props;
  const [note, setNote] = useState<{ text: string; good?: boolean } | null>(null);
  const [view, setView] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setNote({ text: (error as Error).message, good: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-file={file.name ?? ""}>
      <div className="row">
        <div className="grow">
          <strong>{file.name}</strong>
          <div className="quiet">
            {file.size} bytes · {file.status}
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const { data, name, mime } = await memdot.files.get(file.id);
              download(data, name, mime);
              setNote({ text: `Decrypted here: ${data.length} bytes.`, good: true });
            })
          }
        >
          Download
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setNote({ text: "Asking Portaldot V3 from this browser…" });
              const check = await memdot.files.verify(file.id);
              setNote({
                text: check.ok
                  ? `On chain, and the bytes match: ${check.blobs[0]?.cid}`
                  : "The chain doesn't match this file.",
                good: check.ok,
              });
            })
          }
        >
          Verify
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(async () => setView(view ? null : await serverView(apiKey, file.id)))}
        >
          {view ? "Hide" : "What the server sees"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await memdot.files.delete(file.id);
              onGone();
            })
          }
        >
          Delete
        </button>
      </div>
      {note ? (
        <p
          className={note.good === undefined ? "quiet" : note.good ? "good" : "bad"}
          style={{ margin: "8px 0 0" }}
        >
          {note.text}
        </p>
      ) : null}
      {view ? <pre>{JSON.stringify(view, null, 2)}</pre> : null}
    </div>
  );
}

function Vault(props: { connection: Connection; onLeave: () => void }) {
  const { connection, onLeave } = props;
  const memdot = useMemo(() => clientFor(connection), [connection]);
  const [spaces, setSpaces] = useState<{ id: string; name: string | null }[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [files, setFiles] = useState<ListedFile[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    memdot.spaces
      .list()
      .then((rows) => {
        setSpaces(rows);
        setSpaceId((current) => current || rows[0]?.id || "");
      })
      .catch((caught: Error) => setError(caught.message));
  }, [memdot]);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    const { items } = await memdot.files.list({ spaceId });
    setFiles(items);
  }, [memdot, spaceId]);

  useEffect(() => {
    refresh().catch((caught: Error) => setError(caught.message));
  }, [refresh]);

  const upload = async (chosen: File) => {
    setError(null);
    try {
      setStatus(`Encrypting ${chosen.name} in this tab…`);
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      await memdot.files.put(bytes, {
        spaceId,
        name: chosen.name,
        mime: chosen.type || "application/octet-stream",
        onProgress: (job) => setStatus(`${chosen.name}: ${job.status}`),
      });
      setStatus(`${chosen.name} is on Portaldot V3.`);
      await refresh();
    } catch (caught) {
      setStatus(null);
      setError((caught as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <div className="row">
          <select
            value={spaceId}
            onChange={(event) => setSpaceId(event.target.value)}
            aria-label="Space"
          >
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name ?? space.id}
              </option>
            ))}
          </select>
          <input
            type="file"
            aria-label="Add a file"
            className="grow"
            disabled={!spaceId}
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) void upload(chosen);
              event.target.value = "";
            }}
          />
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
        {status ? (
          <p className="quiet" style={{ margin: "8px 0 0" }}>
            {status}
          </p>
        ) : null}
        {error ? (
          <p className="bad" style={{ margin: "8px 0 0" }}>
            {error}
          </p>
        ) : null}
      </div>
      {files.length === 0 && spaceId ? (
        <p className="quiet">Nothing here yet. Add a file above.</p>
      ) : null}
      {files.map((file) => (
        <FileRow
          key={file.id}
          file={file}
          memdot={memdot}
          apiKey={connection.apiKey}
          onGone={() => void refresh()}
        />
      ))}
    </>
  );
}

function App() {
  const [connection, setConnection] = useState<Connection | null>(savedConnection);
  return (
    <main>
      <h1>File vault</h1>
      <p className="quiet">
        Files are encrypted in this tab before they leave it. MemDot stores ciphertext on Portaldot
        V3 and can't read it, and Verify asks the chain directly.
      </p>
      {connection ? (
        <Vault connection={connection} onLeave={() => setConnection(null)} />
      ) : (
        <ConnectScreen label={LABEL} client={CLIENT} onConnected={setConnection} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
