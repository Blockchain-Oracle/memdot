"use client";

import type { Namespace } from "@memdot/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemDot } from "@/lib/memdot";

export function useNamespaces() {
  const memdot = useMemDot();
  return useQuery({ queryKey: ["namespaces"], queryFn: () => memdot.memories.namespaces() });
}

export function useNamespace(id: string | undefined): {
  namespace: Namespace | undefined;
  isPending: boolean;
} {
  const { data, isPending } = useNamespaces();
  return { namespace: data?.find((row) => row.id === id), isPending };
}
