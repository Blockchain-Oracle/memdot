"use client";

import { CodeBlock } from "@memdot/ui/components/code-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@memdot/ui/components/tabs";
import { API_URL } from "@/lib/env";

const MCP_URL = `${API_URL}/mcp`;
const INSTALL = () => `npm install -g ${window.location.origin}/cli/memdot-cli.tgz`;

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] text-text-3 tabular">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-ui-sm text-text-2">{children}</div>
    </div>
  );
}

function Both({ hosted, local }: { hosted: React.ReactNode; local: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui font-medium">Sign in with OAuth</h3>
          <p className="text-ui-sm text-text-3">Nothing to install. Assisted namespaces only.</p>
        </div>
        {hosted}
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui font-medium">Run it on this machine</h3>
          <p className="text-ui-sm text-text-3">
            Decrypts here with its own key, so it also reaches Private namespaces and files.
          </p>
        </div>
        {local}
      </section>
    </div>
  );
}

function LoginFirst() {
  return (
    <Step n={1}>
      Install the CLI and connect it. Your browser asks what it can reach.
      <CodeBlock lang="bash" code={`${INSTALL()}\nmemdot login`} />
    </Step>
  );
}

/** How each client connects: the same steps here, on the Agents page and in setup. */
export function ConnectInstructions() {
  const json = (server: unknown) => JSON.stringify({ mcpServers: { memdot: server } }, null, 2);
  return (
    <Tabs defaultValue="claude-code" className="flex flex-col gap-4">
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
        <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
        <TabsTrigger value="cursor">Cursor</TabsTrigger>
        <TabsTrigger value="cli">CLI</TabsTrigger>
        <TabsTrigger value="sdk">SDK</TabsTrigger>
      </TabsList>

      <TabsContent value="claude-code">
        <Both
          hosted={
            <>
              <Step n={1}>
                Add the server:
                <CodeBlock lang="bash" code={`claude mcp add --transport http memdot ${MCP_URL}`} />
              </Step>
              <Step n={2}>
                In Claude Code, run <code className="font-mono">/mcp</code>, pick memdot and
                authenticate. Your browser asks what it can reach.
              </Step>
            </>
          }
          local={
            <>
              <LoginFirst />
              <Step n={2}>
                Add the server:
                <CodeBlock lang="bash" code="claude mcp add memdot -- memdot mcp" />
              </Step>
            </>
          }
        />
      </TabsContent>

      <TabsContent value="claude-desktop">
        <Both
          hosted={
            <Step n={1}>
              In Settings, under Connectors, add a custom connector with this address, then connect
              it. Your browser asks what it can reach.
              <CodeBlock lang="url" code={MCP_URL} />
            </Step>
          }
          local={
            <>
              <LoginFirst />
              <Step n={2}>
                Add this to <code className="font-mono">claude_desktop_config.json</code> and
                restart Claude:
                <CodeBlock lang="json" code={json({ command: "memdot", args: ["mcp"] })} />
              </Step>
            </>
          }
        />
      </TabsContent>

      <TabsContent value="cursor">
        <Both
          hosted={
            <Step n={1}>
              Add this to <code className="font-mono">~/.cursor/mcp.json</code>, then connect it in
              Cursor's MCP settings:
              <CodeBlock lang="json" code={json({ type: "http", url: MCP_URL })} />
            </Step>
          }
          local={
            <>
              <LoginFirst />
              <Step n={2}>
                Add this to <code className="font-mono">~/.cursor/mcp.json</code>:
                <CodeBlock lang="json" code={json({ command: "memdot", args: ["mcp"] })} />
              </Step>
            </>
          }
        />
      </TabsContent>

      <TabsContent value="cli" className="flex flex-col gap-3">
        <LoginFirst />
        <Step n={2}>
          Remember something and find it again. Add <code className="font-mono">--agent</code> to
          any command for JSON.
          <CodeBlock
            lang="bash"
            code={`memdot add "I prefer short answers" -u me --no-infer\nmemdot search "how should you answer?" -u me`}
          />
        </Step>
      </TabsContent>

      <TabsContent value="sdk" className="flex flex-col gap-3">
        <Step n={1}>
          After <code className="font-mono">memdot login</code>, your code can act as that agent:
          <CodeBlock
            lang="ts"
            code={`import { clientFor, loadCredentials, resolveCredentials } from "@memdot/sdk/credentials";

const resolved = resolveCredentials(await loadCredentials());
const memdot = await clientFor(resolved, "my-agent");

await memdot.memories.add("I prefer short answers", { userId: "me", infer: false });
const found = await memdot.memories.search("how should you answer?");`}
          />
        </Step>
      </TabsContent>
    </Tabs>
  );
}
