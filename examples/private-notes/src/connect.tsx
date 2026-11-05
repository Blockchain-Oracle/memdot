import { type ConnectStart, MemDot, newAgentIdentity } from "@memdot/sdk";
import { useEffect, useRef, useState } from "react";

export const API_URL = import.meta.env.VITE_MEMDOT_API_URL ?? "https://api.84.46.247.92.sslip.io";
const POLL_MS = 2000;
const STORAGE_KEY = "memdot-example-connection";

export interface Connection {
  apiKey: string;
  identity: string;
  namespaceId: string | null;
}

/**
 * Lives for this tab only. An identity opens every space it was given, so keep it out of anything a
 * script from another site could read, and revoke it under Agents when you're done.
 */
export const savedConnection = (): Connection | null => {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Connection) : null;
};
const saveConnection = (connection: Connection) =>
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
export const forgetConnection = () => sessionStorage.removeItem(STORAGE_KEY);

/**
 * "Connect with MemDot": this page makes a key pair and asks. You approve in your dashboard, where
 * your browser wraps the spaces you chose to this page's public key. The private half never leaves.
 */
export function ConnectScreen(props: {
  label: string;
  client: string;
  onConnected: (connection: Connection) => void;
}) {
  const { label, client, onConnected } = props;
  const [request, setRequest] = useState<ConnectStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const memdot = MemDot.create({ baseUrl: API_URL, client, credentials: "omit" });
    const key = newAgentIdentity();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (id: string, secret: string) => {
      try {
        const result = await memdot.agents.pollConnect(id, secret, key.identity);
        if (result.status === "approved" && result.apiKey) {
          const connection = {
            apiKey: result.apiKey,
            identity: key.identity,
            namespaceId: result.namespaceId,
          };
          saveConnection(connection);
          onConnected(connection);
          return;
        }
        if (result.status === "denied" || result.status === "expired") {
          setError(`The request was ${result.status}. Reload to try again.`);
          return;
        }
      } catch (caught) {
        setError((caught as Error).message);
        return;
      }
      timer = setTimeout(() => poll(id, secret), POLL_MS);
    };
    memdot.agents
      .startConnect({ publicKey: key.publicKey, label, client })
      .then((created) => {
        setRequest(created);
        return poll(created.id, created.pollSecret);
      })
      .catch((caught: Error) => setError(caught.message));
    return () => clearTimeout(timer);
  }, [client, label, onConnected]);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Connect your MemDot account</h2>
      {error ? <p className="bad">{error}</p> : null}
      {request ? (
        <>
          <p>
            Approve this page in your dashboard, and choose what it can reach. Type this code there:
          </p>
          <p className="code">{request.code}</p>
          <a className="button primary" href={request.url} target="_blank" rel="noreferrer">
            Open MemDot
          </a>
          <p className="quiet" style={{ marginTop: 12 }}>
            Waiting for you to approve it…
          </p>
        </>
      ) : error ? null : (
        <p className="quiet">Asking MemDot…</p>
      )}
    </div>
  );
}
