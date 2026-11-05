"use client";

import { NamespacePage } from "@/components/memory/namespace-page";
import { Playground } from "@/components/memory/playground";

export default function PlaygroundPage() {
  return (
    <NamespacePage
      title="Playground"
      description="Chat with a namespace, and watch what it recalls and keeps."
      empty="Make a namespace to chat with it."
    >
      {(namespace) => <Playground key={namespace.id} namespace={namespace} />}
    </NamespacePage>
  );
}
