"use client";

import type { Namespace } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { Textarea } from "@memdot/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, PlusIcon, SparklesIcon, UploadIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { saveBytes } from "@/components/files/file-sheet";
import { useUploads } from "@/components/files/uploads";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";

const MAX_IMPORT_BYTES = 1024 * 1024;

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-h3">{title}</h2>
        <p className="text-ui-sm text-text-3">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Maintenance({
  title,
  description,
  action,
  busy,
  onClick,
}: {
  title: string;
  description: string;
  action: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4 first:border-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui">{title}</span>
        <span className="text-ui-sm text-text-3">{description}</span>
      </span>
      <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={onClick}>
        {busy && <Spinner data-icon="inline-start" />} {action}
      </Button>
    </div>
  );
}

/** What this namespace extracts, moving its memories in and out, and keeping it healthy. */
export function NamespaceSettings({ namespace }: { namespace: Namespace }) {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { wallet } = useUploads();
  const id = useId();
  const importInput = useRef<HTMLInputElement>(null);
  const [instructions, setInstructions] = useState("");
  const [categories, setCategories] = useState<{ name: string; description?: string }[]>([]);
  const [newCategory, setNewCategory] = useState("");
  const [useCase, setUseCase] = useState("");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const isPrivate = namespace.mode === "private";

  const settings = useQuery({
    queryKey: ["namespace-settings", namespace.id],
    queryFn: () => memdot.memories.settings(namespace.id),
  });
  useEffect(() => {
    if (!settings.data) return;
    setInstructions(settings.data.customInstructions ?? "");
    setCategories(settings.data.categories ?? []);
  }, [settings.data]);

  const fail = (error: unknown) => toast.error(describeError(error).title);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
    await queryClient.invalidateQueries({ queryKey: ["entities", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const save = useMutation({
    mutationFn: () =>
      memdot.memories.setSettings(namespace.id, {
        customInstructions: instructions.trim() || null,
        categories: categories.length ? categories : null,
      }),
    onSuccess: async () => {
      toast.success("Saved. New memories follow these from now on.");
      await queryClient.invalidateQueries({ queryKey: ["namespace-settings", namespace.id] });
    },
    onError: fail,
  });
  const generate = useMutation({
    mutationFn: () => memdot.memories.generateInstructions(useCase, { namespaceId: namespace.id }),
    onSuccess: (draft) => {
      setInstructions(draft.custom_instructions);
      setTestMessage(draft.test_message);
    },
    onError: fail,
  });
  const restore = useMutation({
    mutationFn: () => memdot.memories.restore(namespace.id),
    onSuccess: async () => {
      toast.success("Rebuilt from what's on chain.");
      await refresh();
    },
    onError: fail,
  });
  const compact = useMutation({
    mutationFn: () => memdot.memories.compact(namespace.id, wallet ? { wallet } : {}),
    onSuccess: async () => {
      toast.success("Checked. Half-dead segments are merged when there are any.");
      await refresh();
    },
    onError: fail,
  });
  const saveIndex = useMutation({
    mutationFn: () => memdot.memories.saveIndex(namespace.id, wallet ? { wallet } : {}),
    onSuccess: () => toast.success("The encrypted index is on chain."),
    onError: fail,
  });
  const exportJson = useMutation({
    mutationFn: async () => {
      const memories = await memdot.memories.exportMemories(namespace.id);
      saveBytes(
        new TextEncoder().encode(JSON.stringify({ memories }, null, 2)),
        `${namespace.name ?? namespace.id}-memories.json`,
        "application/json",
      );
    },
    onError: fail,
  });
  const importFile = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_IMPORT_BYTES) {
        throw new Error("That file is over 1 MB. Split it, or import it through the SDK.");
      }
      const data = JSON.parse(await file.text()) as unknown;
      return memdot.memories.importMemories(data, {
        namespaceId: namespace.id,
        source: file.name.slice(0, 64),
        userId: "imported",
        ...(wallet ? { wallet } : {}),
      });
    },
    onSuccess: async (report) => {
      toast.success(
        `Imported ${report.imported}. ${report.duplicates} already known, ${report.skipped} without text.`,
      );
      await refresh();
    },
    onError: fail,
  });

  return (
    <div className="flex flex-col gap-4">
      <Group
        title="What to keep"
        description={
          isPrivate
            ? "Sealed on this device. The model you chose reads them when it extracts."
            : "The server gives these to the model when it extracts."
        }
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-usecase`}>Draft from what you're building</Label>
          <div className="flex gap-2">
            <Input
              id={`${id}-usecase`}
              value={useCase}
              placeholder="A support bot for a bakery"
              onChange={(event) => setUseCase(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={!useCase.trim() || generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generate.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SparklesIcon data-icon="inline-start" />
              )}
              Draft
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-instructions`}>Custom instructions</Label>
          <Textarea
            id={`${id}-instructions`}
            rows={5}
            value={instructions}
            placeholder="Keep order history and allergies. Ignore small talk."
            onChange={(event) => setInstructions(event.target.value)}
          />
          {testMessage && <p className="text-ui-sm text-text-3">Try them with: "{testMessage}"</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-category`}>Categories</Label>
          {categories.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {categories.map((category) => (
                <li
                  key={category.name}
                  className="flex items-center gap-1 rounded-full border border-border py-0.5 pr-1 pl-2.5 text-ui-sm"
                >
                  {category.name}
                  <button
                    type="button"
                    aria-label={`Remove ${category.name}`}
                    className="rounded-full p-0.5 text-text-3 hover:bg-surface-2 hover:text-foreground"
                    onClick={() =>
                      setCategories((list) => list.filter((c) => c.name !== category.name))
                    }
                  >
                    <XIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newCategory.trim().toLowerCase().replace(/\s+/g, "_");
              if (name && !categories.some((c) => c.name === name)) {
                setCategories((list) => [...list, { name }]);
              }
              setNewCategory("");
            }}
          >
            <Input
              id={`${id}-category`}
              value={newCategory}
              placeholder="order_history"
              onChange={(event) => setNewCategory(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={!newCategory.trim()}>
              <PlusIcon data-icon="inline-start" /> Add
            </Button>
          </form>
          <p className="text-ui-sm text-text-3">
            With none set, memories are filed under a standard list such as food, travel and
            technology.
          </p>
        </div>
        <div className="flex justify-end">
          <Button disabled={save.isPending || settings.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Spinner data-icon="inline-start" />} Save
          </Button>
        </div>
      </Group>

      <Group
        title="Move memories"
        description="As JSON. Imports read MemDot's own file, or a list or {results: [...]} from another memory product such as Mem0. No model is involved, and the same fact in the same scope is dropped."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={exportJson.isPending}
            onClick={() => exportJson.mutate()}
          >
            {exportJson.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <DownloadIcon data-icon="inline-start" />
            )}
            Export JSON
          </Button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importFile.mutate(file);
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            disabled={importFile.isPending}
            onClick={() => importInput.current?.click()}
          >
            {importFile.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <UploadIcon data-icon="inline-start" />
            )}
            Import JSON
          </Button>
        </div>
      </Group>

      <Group
        title="Keep it healthy"
        description="Everything the index holds can be derived again from the chain."
      >
        <Maintenance
          title="Rebuild the index"
          description={
            isPrivate
              ? "Throws away what this device holds and reads every segment back from V3."
              : "Reads every segment back from V3 and derives the text, keywords and vectors again."
          }
          action="Rebuild"
          busy={restore.isPending}
          onClick={() => restore.mutate()}
        />
        <Maintenance
          title="Merge segments"
          description={
            isPrivate
              ? "Rewrites mostly forgotten segments into one. Costs a store."
              : "Runs by itself; this just checks now."
          }
          action="Merge"
          busy={compact.isPending}
          onClick={() => compact.mutate()}
        />
        {isPrivate && (
          <Maintenance
            title="Save the index"
            description="Stores it encrypted on V3, so another device can start without embedding everything again. Also happens every 100 writes."
            action="Save"
            busy={saveIndex.isPending}
            onClick={() => saveIndex.mutate()}
          />
        )}
        <Maintenance
          title="Forget everything"
          description="Clears this namespace and stops renewing its segments."
          action="Forget all"
          onClick={() => setConfirmReset(true)}
        />
      </Group>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={`Forget everything in ${namespace.name ?? "this namespace"}?`}
        description="All its memories leave search and lists at once, and its segments expire from the chain within 7 days. Anything already read can't be recalled."
        action="Forget all"
        onConfirm={async () => {
          await memdot.memories.reset(namespace.id);
          await refresh();
          router.refresh();
        }}
      />
    </div>
  );
}
