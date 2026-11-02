"use client";

import { type ExportProgress, type ImportReport, MemDotError } from "@memdot/sdk";
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
import { Label } from "@memdot/ui/components/label";
import { Progress } from "@memdot/ui/components/progress";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { saveBytes } from "@/components/files/file-sheet";
import { clearAuthFlow } from "@/lib/auth-flow";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";

/** Typed to confirm: deleting an account can't be undone. */
const CONFIRM_PHRASE = "delete my account";

function Block({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-h2">{title}</h2>
        <p className="text-ui-sm text-text-3">{description}</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface-1">{children}</div>
    </section>
  );
}

function Line({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui">{title}</span>
        <span className="text-ui-sm text-text-3">{description}</span>
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Progressing({ progress }: { progress: ExportProgress | null }) {
  if (!progress) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
      <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
      <span className="truncate text-ui-sm text-text-3">
        {progress.done} of {progress.total}: {progress.step}
      </span>
    </div>
  );
}

/** Settings → Data and the danger zone. Everything here runs on this device. */
export function DataSection() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = useId();
  const zipInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState<ExportProgress | null>(null);
  const [importing, setImporting] = useState<ExportProgress | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [phrase, setPhrase] = useState("");

  const exportAll = useMutation({
    mutationFn: async () => {
      const { zip, failures } = await memdot.data.exportArchive({ onProgress: setExporting });
      saveBytes(
        zip,
        `memdot-export-${new Date().toISOString().slice(0, 10)}.zip`,
        "application/zip",
      );
      return failures;
    },
    onSuccess: (failures) => {
      if (failures.length > 0) {
        toast.warning(`Exported, but ${failures.length} couldn't be read: ${failures[0]?.item}.`);
      } else toast.success("Exported. It holds your data unencrypted, so keep it safe.");
    },
    onError: (error) => toast.error(describeError(error).title),
    onSettled: () => setExporting(null),
  });
  const importAll = useMutation({
    mutationFn: async (file: File) =>
      memdot.data.importArchive(new Uint8Array(await file.arrayBuffer()), {
        onProgress: setImporting,
      }),
    onSuccess: async (result) => {
      setReport(result);
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(describeError(error).title),
    onSettled: () => setImporting(null),
  });
  const deleteAccount = useMutation({
    mutationFn: () => memdot.data.deleteAccount(),
    onSuccess: () => {
      clearAuthFlow();
      queryClient.clear();
      router.replace("/sign-in");
    },
    onError: (error) => {
      const stale =
        error instanceof MemDotError &&
        (error.code === "SESSION_NOT_FRESH" || error.status === 403);
      toast.error(
        stale
          ? "For your safety, sign in again (within 15 minutes) before deleting your account."
          : describeError(error).title,
      );
    },
  });

  return (
    <>
      <Block
        id="data"
        title="Data"
        description="Take everything with you. It's decrypted on this device."
      >
        <Line
          title="Export everything"
          description="A zip of your files and a JSON of your memories, in the clear. Keep it as carefully as the data itself."
        >
          <Button
            variant="outline"
            size="sm"
            disabled={exportAll.isPending}
            onClick={() => exportAll.mutate()}
          >
            {exportAll.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <DownloadIcon data-icon="inline-start" />
            )}
            Export
          </Button>
        </Line>
        <Progressing progress={exporting} />
        <Line
          title="Import an export"
          description="Brings a MemDot export into new spaces here. To import memories from another product, use a namespace's Settings."
        >
          <input
            ref={zipInput}
            type="file"
            accept="application/zip,.zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importAll.mutate(file);
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={importAll.isPending}
            onClick={() => zipInput.current?.click()}
          >
            {importAll.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UploadIcon data-icon="inline-start" />
            )}
            Import
          </Button>
        </Line>
        <Progressing progress={importing} />
        {report && (
          <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-ui-sm">
            <span>
              Brought in {report.files} files and {report.memories} memories, into {report.spaces}{" "}
              spaces. {report.duplicates} memories were already known.
            </span>
            {report.failures.map((failure) => (
              <span key={failure.item} className="text-danger-fg">
                {failure.item}: {failure.reason}
              </span>
            ))}
          </div>
        )}
      </Block>

      <Block
        id="danger"
        title="Danger zone"
        description="There is no undo. Export first if you want a copy."
      >
        <Line
          title="Delete this account"
          description="Stops every renewal, forgets all memories, revokes keys, agents and shares, and removes every way to sign in."
        >
          <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
            Delete account
          </Button>
        </Line>
      </Block>

      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          setDeleting(open);
          if (!open) setPhrase("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this account?</DialogTitle>
            <DialogDescription>
              MemDot stops renewing everything, so the encrypted bytes leave the chain within 7
              days. What you already shared or downloaded can't be recalled.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>
              Type <span className="font-mono">{CONFIRM_PHRASE}</span> to confirm
            </Label>
            <Input
              id={id}
              autoComplete="off"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              Keep my account
            </Button>
            <Button
              variant="destructive"
              disabled={phrase !== CONFIRM_PHRASE || deleteAccount.isPending}
              onClick={() => deleteAccount.mutate()}
            >
              {deleteAccount.isPending && <Spinner data-icon="inline-start" />} Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
