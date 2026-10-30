"use client";

import { API_KEY_VISIBLE_CHARS } from "@memdot/config";
import { CodeBlock } from "@memdot/ui/components/code-block";
import { SecretField } from "@memdot/ui/components/secret-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@memdot/ui/components/tabs";
import { TriangleAlertIcon } from "lucide-react";
import { API_URL } from "@/lib/env";

/** A new key, shown once, with the first request next to it (key and first call in one step). */
export function KeyReveal({ secret, spaceId }: { secret: string; spaceId?: string }) {
  const space = spaceId ?? "<space id>";
  const node = `import { MemDot } from "@memdot/sdk";

const memdot = MemDot.create({
  baseUrl: "${API_URL}",
  apiKey: process.env.MEMDOT_API_KEY,
});
await memdot.account.unlockWithRecoveryCode(process.env.MEMDOT_RECOVERY_CODE!);

const bytes = new TextEncoder().encode("hello from my server");
const { file } = await memdot.files.put(bytes, { spaceId: "${space}", name: "hello.txt" });
console.log(file.cid);`;
  const curl = `curl ${API_URL}/v1/spaces \\
  -H "Authorization: Bearer $MEMDOT_API_KEY"`;

  return (
    <div className="flex flex-col gap-4">
      <SecretField value={secret} visibleChars={API_KEY_VISIBLE_CHARS} />
      <p className="flex gap-2 text-ui-sm text-text-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn-fg" aria-hidden="true" />
        Copy it now. MemDot keeps only a hash, so it cannot show this key again.
      </p>
      <CodeBlock lang=".env" code={`MEMDOT_API_KEY=${secret}`} />
      <Tabs defaultValue="node">
        <TabsList>
          <TabsTrigger value="node">Node</TabsTrigger>
          <TabsTrigger value="curl">curl</TabsTrigger>
        </TabsList>
        <TabsContent value="node">
          <CodeBlock lang="typescript" code={node} />
        </TabsContent>
        <TabsContent value="curl">
          <CodeBlock lang="shell" code={curl} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
