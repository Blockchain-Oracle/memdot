"use client";

import { Copilot } from "@/components/memory/copilot";
import { NamespacePage } from "@/components/memory/namespace-page";

export default function CopilotPage() {
  return (
    <NamespacePage
      title="Copilot"
      description="Ask about your memories and settings. It suggests changes, and you decide."
      empty="Make a namespace and add memories first."
    >
      {(namespace) => <Copilot key={namespace.id} namespace={namespace} />}
    </NamespacePage>
  );
}
