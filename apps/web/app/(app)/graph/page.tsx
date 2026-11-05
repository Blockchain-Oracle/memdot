"use client";

import { GraphView } from "@/components/memory/graph-view";
import { NamespacePage } from "@/components/memory/namespace-page";

export default function GraphPage() {
  return (
    <NamespacePage
      title="Graph"
      description="Who and what your memories mention, and how those connect."
      empty="The graph appears once memories are added."
    >
      {(namespace) => <GraphView key={namespace.id} namespace={namespace} />}
    </NamespacePage>
  );
}
