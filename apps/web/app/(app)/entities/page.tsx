"use client";

import { EntitiesTable } from "@/components/memory/entities-table";
import { NamespacePage } from "@/components/memory/namespace-page";

/** Everyone a namespace remembers: users, agents and runs, with what forgetting one would take. */
export default function EntitiesPage() {
  return (
    <NamespacePage
      title="Entities"
      description="The users, agents and runs your memories are about."
      empty="Entities appear once memories are added for them."
    >
      {(namespace) => <EntitiesTable key={namespace.id} namespace={namespace} />}
    </NamespacePage>
  );
}
