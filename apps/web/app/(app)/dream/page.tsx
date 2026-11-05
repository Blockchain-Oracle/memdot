"use client";

import { Dream } from "@/components/memory/dream";
import { NamespacePage } from "@/components/memory/namespace-page";

export default function DreamPage() {
  return (
    <NamespacePage
      title="Dream"
      description="Have a model look over a namespace, then apply what you agree with."
      empty="Make a namespace and add memories first."
    >
      {(namespace) => <Dream key={namespace.id} namespace={namespace} />}
    </NamespacePage>
  );
}
