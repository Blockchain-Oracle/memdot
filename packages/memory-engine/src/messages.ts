/** One part of a message: text, or a picture or document for the model to read. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "pdf_url"; pdf_url: { url: string } }
  | { type: "txt_url"; txt_url: { url: string } }
  | { type: "mdx_url"; mdx_url: { url: string } };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
  name?: string | undefined;
}

/** Messages may be a bare string; the caller meant one user turn. */
export function normalizeMessages(input: string | ChatMessage | ChatMessage[]): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return Array.isArray(input) ? input : [input];
}

/** A message's text alone, for embedding or storing as written. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
}

export const hasAttachments = (messages: ChatMessage[]) =>
  messages.some(
    (message) =>
      typeof message.content !== "string" && message.content.some((part) => part.type !== "text"),
  );
