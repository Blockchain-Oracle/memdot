"use client";

import type { Namespace } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@memdot/ui/components/dialog";
import { Input } from "@memdot/ui/components/input";
import { JsonViewer } from "@memdot/ui/components/json-viewer";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { Textarea } from "@memdot/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import { useId, useState } from "react";
import { saveBytes } from "@/components/files/file-sheet";
import { formatNumber } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { ModelError } from "./model-error";

const STARTER = `{
  "type": "object",
  "properties": {
    "preferences": { "type": "array", "items": { "type": "string" } },
    "open_questions": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["preferences", "open_questions"]
}`;

function parseSchema(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Turns memories into the JSON another system wants: one model call, shown before it's saved. */
export function SchemaExportDialog({
  namespace,
  open,
  onOpenChange,
}: {
  namespace: Namespace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const memdot = useMemDot();
  const id = useId();
  const [schema, setSchema] = useState(STARTER);
  const [instructions, setInstructions] = useState("");
  const parsed = parseSchema(schema);
  const run = useMutation({
    mutationFn: () =>
      memdot.memories.exportToSchema({
        namespaceId: namespace.id,
        schema: parsed as Record<string, unknown>,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fill a schema from memories</DialogTitle>
          <DialogDescription>
            {namespace.mode === "private"
              ? "Your model reads up to 500 memories, on this device. One model call."
              : "The server's model reads up to 500 memories. One model call."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-schema`}>JSON schema</Label>
            <Textarea
              id={`${id}-schema`}
              rows={8}
              spellCheck={false}
              className="font-mono text-ui-sm"
              value={schema}
              aria-invalid={!parsed}
              onChange={(event) => setSchema(event.target.value)}
            />
            {!parsed && <p className="text-ui-sm text-danger-fg">That isn't a JSON object yet.</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-instructions`}>Instructions, if any</Label>
            <Input
              id={`${id}-instructions`}
              value={instructions}
              placeholder="Only what's still true"
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
          {run.error && <ModelError error={run.error} />}
          {run.data && (
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">
                From {formatNumber(run.data.memoriesRead)}{" "}
                {run.data.memoriesRead === 1 ? "memory" : "memories"}
              </span>
              <div className="max-h-64 overflow-auto rounded-lg border border-border p-2">
                <JsonViewer value={run.data.result as object} />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          {run.data && (
            <Button
              variant="outline"
              onClick={() =>
                saveBytes(
                  new TextEncoder().encode(JSON.stringify(run.data.result, null, 2)),
                  `${namespace.name ?? namespace.id}-export.json`,
                  "application/json",
                )
              }
            >
              <DownloadIcon data-icon="inline-start" /> Download
            </Button>
          )}
          <Button disabled={!parsed || run.isPending} onClick={() => run.mutate()}>
            {run.isPending && <Spinner data-icon="inline-start" />} Fill it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
