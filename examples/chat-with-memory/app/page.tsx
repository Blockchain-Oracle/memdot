"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";

/** Saving and distilling happen after a reply, so look again for a while. */
const REFRESH_MS = 3000;
const REFRESH_TIMES = 15;

interface PanelMemory {
  id: string;
  memory: string;
  createdAt: string;
}

const textOf = (message: ChatMessage) =>
  message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

export default function Page() {
  const { messages, sendMessage, setMessages, status, error } = useChat<ChatMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [draft, setDraft] = useState("");
  const [memories, setMemories] = useState<PanelMemory[] | null>(null);
  const refreshes = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/memories");
    if (response.ok) setMemories(((await response.json()) as { memories: PanelMemory[] }).memories);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (refreshes.current) clearInterval(refreshes.current);
    };
  }, [load]);

  const refreshForAWhile = () => {
    if (refreshes.current) clearInterval(refreshes.current);
    let left = REFRESH_TIMES;
    refreshes.current = setInterval(() => {
      left -= 1;
      void load();
      if (left <= 0 && refreshes.current) clearInterval(refreshes.current);
    }, REFRESH_MS);
  };

  const busy = status === "submitted" || status === "streaming";
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) refreshForAWhile();
    wasBusy.current = busy;
  });

  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void sendMessage({ text });
  };

  const forget = async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div className="page">
      <section className="chat">
        <header>
          <h1>Chat with memory</h1>
          <button type="button" onClick={() => setMessages([])} disabled={busy || !messages.length}>
            New conversation
          </button>
        </header>
        <div className="messages">
          {messages.length === 0 ? (
            <p className="quiet">
              Tell it something about yourself, then start a new conversation and ask. The new one
              starts with nothing but what's in the panel.
            </p>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              <div>{textOf(message)}</div>
              {message.role === "assistant" && message.metadata?.recalled?.length ? (
                <details className="used">
                  <summary>
                    Used {message.metadata.recalled.length}{" "}
                    {message.metadata.recalled.length === 1 ? "memory" : "memories"}
                  </summary>
                  <ul>
                    {message.metadata.recalled.map((hit) => (
                      <li key={hit.id}>
                        {hit.memory} <span className="quiet">({Math.round(hit.score * 100)}%)</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))}
          {error ? <p className="bad">{error.message}</p> : null}
        </div>
        <form onSubmit={send}>
          <input
            aria-label="Message"
            placeholder="Say something"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !draft.trim()}>
            Send
          </button>
        </form>
      </section>

      <aside className="panel">
        <h2>What it remembers about you</h2>
        <p className="quiet">
          Encrypted and stored on Portaldot V3. A model picks out what's worth keeping.
        </p>
        {memories === null ? <p className="quiet">Loading…</p> : null}
        {memories?.length === 0 ? <p className="quiet">Nothing yet.</p> : null}
        <ul>
          {memories?.map((memory) => (
            <li key={memory.id}>
              <span>{memory.memory}</span>
              <button
                type="button"
                aria-label={`Forget: ${memory.memory}`}
                onClick={() => forget(memory.id)}
              >
                Forget
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
