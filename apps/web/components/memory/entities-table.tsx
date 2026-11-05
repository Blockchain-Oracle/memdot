"use client";

import type { Entity, Namespace } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { Skeleton } from "@memdot/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@memdot/ui/components/table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrashIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { describeError } from "@/lib/errors";
import { formatNumber, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

/** After the `#`, so a Private namespace's user id stays out of what the web server is asked for. */
export const personHref = (namespaceId: string, userId: string) =>
  `/entities/${namespaceId}#${encodeURIComponent(userId)}`;

/** The users, agents and runs a namespace remembers. Forgetting one forgets its memories. */
export function EntitiesTable({ namespace }: { namespace: Namespace }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<Entity | null>(null);
  const entities = useQuery({
    queryKey: ["entities", namespace.id],
    queryFn: () => memdot.memories.entities({ namespaceId: namespace.id }),
  });

  if (entities.isPending) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (entities.error) {
    return (
      <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui text-danger-fg">
        {describeError(entities.error).title}
      </p>
    );
  }
  if (entities.data.length === 0) {
    return (
      <Empty className="rounded-xl border border-dashed border-border-strong py-16">
        <EmptyHeader>
          <EmptyTitle>No users, agents or runs yet</EmptyTitle>
          <EmptyDescription>They appear here as memories are added for them.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Id</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Memories</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Last active</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {entities.data.map((entity) => (
            <TableRow key={`${entity.type}:${entity.id}`}>
              <TableCell className="max-w-48 truncate font-mono text-ui-sm">
                {entity.type === "user" ? (
                  <Link
                    href={personHref(namespace.id, entity.id)}
                    className="underline-offset-4 hover:underline"
                  >
                    {entity.id}
                  </Link>
                ) : (
                  entity.id
                )}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="font-normal">
                  {entity.type}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-ui-sm tabular">
                {formatNumber(entity.totalMemories)}
              </TableCell>
              <TableCell className="hidden text-right text-ui-sm text-text-3 sm:table-cell">
                {formatRelative(entity.updatedAt)}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Forget ${entity.type} ${entity.id}`}
                  onClick={() => setDeleting(entity)}
                >
                  <TrashIcon />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Forget ${deleting?.type} ${deleting?.id}?`}
        description={`Its ${formatNumber(deleting?.totalMemories ?? 0)} memories leave search and lists at once. Encrypted entries leave the chain when their segments are rewritten or expire, and anything already read can't be recalled.`}
        action="Forget"
        onConfirm={async () => {
          if (!deleting) return;
          await memdot.memories.deleteEntity(deleting.type, deleting.id, {
            namespaceId: namespace.id,
          });
          await queryClient.invalidateQueries({ queryKey: ["entities", namespace.id] });
          await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
          await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
        }}
      />
    </div>
  );
}
