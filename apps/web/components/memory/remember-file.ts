import type { FileInfo, MemDot, MemoryMode } from "@memdot/sdk";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";

/** Scope for what a file teaches; the dashboard's own user. */
const FILE_MEMORY_USER = "me";
/** The API takes JSON up to 1 MiB, which holds a document of about 700 KB once encoded. */
const MAX_READABLE_BYTES = 700 * 1024;

const isTextLike = (mime: string, name: string) =>
  mime.startsWith("text/") ||
  /json|xml|yaml|markdown/.test(mime) ||
  /\.(md|mdx|txt|csv|json|ya?ml|log)$/i.test(name);

async function asDataUrl(file: File): Promise<string> {
  let binary = "";
  for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte);
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

/**
 * A file stored in a memory-mode folder: its text goes to the namespace's model, and what comes
 * back links to the file, so deleting the file deletes these memories (R8).
 */
export async function rememberFile(
  memdot: MemDot,
  file: File,
  stored: FileInfo,
  namespaceId: string,
): Promise<void> {
  const name = file.name;
  try {
    if (file.size > MAX_READABLE_BYTES) {
      toast.info(`${name} is too big to read for memories. It's stored all the same.`);
      return;
    }
    const content = isTextLike(file.type, name)
      ? await file.text()
      : file.type.startsWith("image/")
        ? [{ type: "image_url" as const, image_url: { url: await asDataUrl(file) } }]
        : file.type === "application/pdf"
          ? [{ type: "pdf_url" as const, pdf_url: { url: await asDataUrl(file) } }]
          : null;
    if (content === null) {
      toast.info(`MemDot can't read ${name} for memories. It's stored all the same.`);
      return;
    }
    await memdot.memories.add([{ role: "user", content }], {
      namespaceId,
      userId: FILE_MEMORY_USER,
      source: { objectId: stored.id, label: name },
      wait: false,
    });
    toast.success(`Reading ${name} for memories.`);
  } catch (error) {
    toast.error(`Couldn't read ${name} for memories: ${describeError(error).title}`);
  }
}

export const READ_NOTICE: Record<MemoryMode, string> = {
  assisted:
    "This is a memory folder: MemDot's server reads these files to extract memories, and doesn't store the text in the clear. Deleting a file deletes what was learned from it.",
  private:
    "This is a memory folder: these files are read on this device, by the model you chose. Deleting a file deletes what was learned from it.",
};
