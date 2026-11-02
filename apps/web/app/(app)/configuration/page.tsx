"use client";

import { EMBEDDING_PROVIDERS, type LlmProvider, PROVIDERS } from "@memdot/memory-engine";
import type { Schemas } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@memdot/ui/components/select";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, EyeOffIcon, LockIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Page, PageHeader } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";

type Effective = Schemas["MemoryConfiguration"]["llm"];

const SOURCE_LABEL: Record<Effective["source"], string> = {
  account: "Your key",
  service: "MemDot's key",
  none: "Not set",
};

/** Provider, model, key and (for an OpenAI-compatible host) address. The key is write-only. */
function ModelFields({
  kind,
  current,
  onSave,
  onClear,
  saving,
}: {
  kind: "llm" | "embedder";
  current: Effective | undefined;
  onSave: (value: { provider: string; model: string; api_key?: string; base_url?: string }) => void;
  onClear: (() => void) | null;
  saving: boolean;
}) {
  const id = useId();
  const providers =
    kind === "llm"
      ? PROVIDERS
      : PROVIDERS.filter((p) => (EMBEDDING_PROVIDERS as readonly string[]).includes(p.id));
  const [provider, setProvider] = useState<string>(providers[0]?.id ?? "google");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const info = providers.find((p) => p.id === provider);
  const suggestions = kind === "llm" ? info?.llmModels : info?.embeddingModels;
  const own = current?.source === "account";

  useEffect(() => {
    if (own && current?.provider) {
      setProvider(current.provider);
      setModel(current.model ?? "");
      setBaseUrl(current.base_url ?? "");
    }
  }, [own, current]);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          provider,
          model: model.trim(),
          ...(apiKey ? { api_key: apiKey } : {}),
          ...(info?.needsBaseUrl && baseUrl ? { base_url: baseUrl } : {}),
        });
        setApiKey("");
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-provider`}>Provider</Label>
          <Select
            value={provider}
            onValueChange={(next) => {
              setProvider(next);
              setModel("");
            }}
          >
            <SelectTrigger id={`${id}-provider`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-model`}>Model</Label>
          <Input
            id={`${id}-model`}
            required
            className="font-mono"
            list={`${id}-models`}
            value={model}
            placeholder={suggestions?.[0] ?? "model-id"}
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id={`${id}-models`}>
            {suggestions?.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>
      </div>
      {info?.needsBaseUrl && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-url`}>Address</Label>
          <Input
            id={`${id}-url`}
            type="url"
            required
            className="font-mono"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-key`}>API key</Label>
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          className="font-mono"
          value={apiKey}
          required={!own}
          placeholder={own ? "Saved. Type to replace it." : "Paste your key"}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {onClear && (
          <Button type="button" variant="ghost" onClick={onClear}>
            Use MemDot's
          </Button>
        )}
        <Button type="submit" disabled={saving || !model.trim()}>
          {saving && <Spinner data-icon="inline-start" />} Save
        </Button>
      </div>
    </form>
  );
}

function Card({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-h3">{title}</h2>
          <p className="text-ui-sm text-text-3">{description}</p>
        </div>
        {badge}
      </div>
      {children}
    </section>
  );
}

export default function ConfigurationPage() {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["configure"],
    queryFn: () => memdot.memories.configuration(),
  });
  const privateModel = useQuery({
    queryKey: ["private-model"],
    queryFn: () => memdot.memories.privateModel(),
  });

  const fail = (error: unknown) => toast.error(describeError(error).title);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["configure"] });
  const saveAssisted = useMutation({
    mutationFn: (change: Parameters<typeof memdot.memories.setModels>[0]) =>
      memdot.memories.setModels(change),
    onSuccess: async () => {
      toast.success("Saved. Your key is encrypted and never shown again.");
      await refresh();
    },
    onError: fail,
  });
  const savePrivate = useMutation({
    mutationFn: (change: Parameters<typeof memdot.memories.setPrivateModel>[0]) =>
      memdot.memories.setPrivateModel(change),
    onSuccess: async () => {
      toast.success("Saved. It's sealed on this device, and MemDot can't read it.");
      await queryClient.invalidateQueries({ queryKey: ["private-model"] });
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => memdot.memories.testModels(),
    onError: fail,
  });

  const badge = (effective: Effective | undefined) =>
    effective ? (
      <Badge variant="outline" className="shrink-0 font-normal">
        {SOURCE_LABEL[effective.source]}
      </Badge>
    ) : null;

  return (
    <Page>
      <PageHeader
        title="Configuration"
        description="The models that read and index your memories."
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-ui font-medium">
            <EyeOffIcon className="size-4 text-text-3" aria-hidden="true" /> Assisted namespaces
          </h2>
          <p className="text-ui-sm text-text-3">
            MemDot's server calls these. Your key is kept encrypted and is never shown again.
            {config.data
              ? ` On MemDot's own key an account gets ${config.data.daily_shared_writes} model calls a day; your own has no limit.`
              : ""}
          </p>
          {config.isPending ? (
            <Skeleton className="h-56 w-full rounded-xl" />
          ) : (
            <>
              <Card
                title="Language model"
                description={
                  config.data?.llm.model
                    ? `Now: ${config.data.llm.model}`
                    : "Extracts facts, summarizes, reranks."
                }
                badge={badge(config.data?.llm)}
              >
                <ModelFields
                  kind="llm"
                  current={config.data?.llm}
                  saving={saveAssisted.isPending}
                  onSave={(llm) => saveAssisted.mutate({ llm: llm as never })}
                  onClear={
                    config.data?.llm.source === "account"
                      ? () => saveAssisted.mutate({ llm: null })
                      : null
                  }
                />
              </Card>
              <Card
                title="Embedding model"
                description={
                  config.data?.embedder.model
                    ? `Now: ${config.data.embedder.model}. It must produce 1536 dimensions. After changing it, rebuild each namespace's index.`
                    : "Turns text into vectors for search. It must produce 1536 dimensions."
                }
                badge={badge(config.data?.embedder)}
              >
                <ModelFields
                  kind="embedder"
                  current={config.data?.embedder}
                  saving={saveAssisted.isPending}
                  onSave={(embedder) => saveAssisted.mutate({ embedder: embedder as never })}
                  onClear={
                    config.data?.embedder.source === "account"
                      ? () => saveAssisted.mutate({ embedder: null })
                      : null
                  }
                />
              </Card>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending && <Spinner data-icon="inline-start" />} Try them
                </Button>
                {test.data &&
                  (
                    [
                      ["Language model", test.data.llm.ok, test.data.llm.error],
                      ["Embeddings", test.data.embedder.ok, test.data.embedder.error],
                    ] as const
                  ).map(([label, ok, error]) => (
                    <span
                      key={label}
                      title={error ?? undefined}
                      className={`flex items-center gap-1.5 text-ui-sm ${ok ? "text-ok-fg" : "text-danger-fg"}`}
                    >
                      {ok ? (
                        <CircleCheckIcon className="size-3.5" aria-hidden="true" />
                      ) : (
                        <CircleXIcon className="size-3.5" aria-hidden="true" />
                      )}
                      {label}
                      {!ok && error ? `: ${error.slice(0, 80)}` : ""}
                    </span>
                  ))}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-ui font-medium">
            <LockIcon className="size-4 text-text-3" aria-hidden="true" /> Private namespaces
          </h2>
          <p className="text-ui-sm text-text-3">
            This browser calls the model directly. Your key is sealed here before it's saved, so
            MemDot can't read it and every device you unlock can. Embedding and search always run on
            this device, with no key.
          </p>
          <Card
            title="Language model"
            description={
              privateModel.data
                ? `Now: ${privateModel.data.model}`
                : "Optional. Without one, Private memories are stored as written."
            }
            badge={
              <Badge variant="outline" className="shrink-0 font-normal">
                {privateModel.data ? "Your key" : "Not set"}
              </Badge>
            }
          >
            <ModelFields
              kind="llm"
              current={
                privateModel.data
                  ? {
                      provider: privateModel.data.provider,
                      model: privateModel.data.model,
                      base_url: privateModel.data.baseUrl ?? null,
                      has_key: true,
                      source: "none",
                    }
                  : undefined
              }
              saving={savePrivate.isPending}
              onSave={({ provider, model, api_key, base_url }) => {
                if (!api_key) {
                  toast.error("Give the API key again: it's sealed together with the model.");
                  return;
                }
                savePrivate.mutate({
                  provider: provider as LlmProvider,
                  model,
                  apiKey: api_key,
                  ...(base_url ? { baseUrl: base_url } : {}),
                });
              }}
              onClear={null}
            />
          </Card>
        </div>
      </div>
    </Page>
  );
}
