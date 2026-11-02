import { spawn } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { type ConnectStart, MemDot, MemDotError, newAgentIdentity } from "@memdot/sdk";
import {
  type Credentials,
  credentialsForApi,
  credentialsPath,
  loadCredentials,
  removeCredentials,
  resolveCredentials,
  saveCredentials,
} from "@memdot/sdk/credentials";
import type { Command } from "commander";
import { connect, credentialsOf, VERSION } from "../context.js";
import { CliError, dim, EXIT, emit, good, interactive, say, strong } from "../output.js";
import { syncKey } from "../sync.js";

/** Long enough for a passkey prompt and a look at the spaces. Matches the server's own limit. */
const LOGIN_WAIT_SECONDS = 600;
const CONTINUE_WAIT_SECONDS = 30;
const SECONDS = 1000;
const CLIENT = `cli/${VERSION}`;

const KNOWN_CLIENTS = [
  ["CLAUDECODE", "claude-code"],
  ["CURSOR_AGENT", "cursor"],
  ["CODEX_CLI", "codex"],
] as const;

const clientName = () => KNOWN_CLIENTS.find(([variable]) => process.env[variable])?.[1] ?? "cli";

const redact = (key: string | undefined | null) => {
  if (!key) return "(not set)";
  return key.length <= 8 ? `${key.slice(0, 2)}***` : `${key.slice(0, 7)}…${key.slice(-4)}`;
};

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  // No browser here: the address is already on screen.
  child.on("error", () => undefined);
  child.unref();
}

/** Saves the key and agent the device collected, and updates the key wherever it's already kept. */
async function finishLogin(
  file: Credentials | null,
  apiUrl: string,
  pending: NonNullable<Credentials["pending"]>,
  collected: { apiKey: string; agentId: string | null; namespaceId: string | null },
): Promise<string[]> {
  const { pending: _done, ...rest } = credentialsForApi(file, apiUrl);
  await saveCredentials({
    ...rest,
    version: 1,
    api_url: apiUrl,
    api_key: collected.apiKey,
    agent: {
      id: collected.agentId ?? "",
      label: pending.label,
      identity: pending.identity,
      public_key: pending.public_key,
    },
    ...(collected.namespaceId ? { namespace_id: collected.namespaceId } : {}),
    // A new memory has to be about someone; here that's you, until you say otherwise.
    defaults: { user_id: userInfo().username, ...rest.defaults },
    created_at: new Date().toISOString(),
  });
  return syncKey(collected.apiKey);
}

/** Asks until the owner has answered, or the time runs out. Null means still waiting. */
async function collect(
  memdot: MemDot,
  pending: NonNullable<Credentials["pending"]>,
  waitSeconds: number,
) {
  const until = Date.now() + waitSeconds * SECONDS;
  for (;;) {
    const result = await memdot.agents.pollConnect(
      pending.id,
      pending.poll_secret,
      pending.identity,
    );
    if (result.status === "approved" && result.apiKey) {
      return {
        apiKey: result.apiKey,
        agentId: result.agentId,
        namespaceId: result.namespaceId,
        ownerAccount: result.ownerAccount,
      };
    }
    if (result.status === "denied") {
      throw new CliError("The request was refused in the browser.", EXIT.auth, "CONNECT_DENIED");
    }
    if (result.status === "expired") {
      throw new CliError(
        "The request expired. Run memdot login again.",
        EXIT.auth,
        "CONNECT_EXPIRED",
      );
    }
    if (result.status === "delivered") {
      throw new CliError(
        "That result was already collected. Run memdot login again.",
        EXIT.conflict,
        "CONNECT_DELIVERED",
      );
    }
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, 2 * SECONDS));
  }
}

function pendingFrom(
  started: ConnectStart,
  key: { identity: string; publicKey: string },
  label: string,
): NonNullable<Credentials["pending"]> {
  return {
    id: started.id,
    code: started.code,
    url: started.url,
    poll_secret: started.pollSecret,
    expires_at: started.expiresAt,
    identity: key.identity,
    public_key: key.publicKey,
    label,
  };
}

async function saveApiKey(apiUrl: string, key: string, namespace: string | undefined) {
  const memdot = MemDot.create({ baseUrl: apiUrl, apiKey: key, client: CLIENT });
  await memdot.usage().catch((error: unknown) => {
    if (error instanceof MemDotError && error.status === 401) {
      throw new CliError("That API key isn't valid.", EXIT.auth, "BAD_KEY");
    }
    throw error;
  });
  const file = await loadCredentials();
  const { agent: _replaced, pending: _dropped, ...rest } = credentialsForApi(file, apiUrl);
  await saveCredentials({
    ...rest,
    version: 1,
    api_url: apiUrl,
    api_key: key,
    ...(namespace ? { namespace_id: namespace } : {}),
    created_at: new Date().toISOString(),
  });
  return syncKey(key);
}

interface LoginOptions {
  label: string;
  withKey?: string;
  browser?: boolean;
  /** false: --no-wait. A number: how long --continue waits. */
  wait?: number | false;
  continue?: boolean;
}

async function runLogin(options: LoginOptions, command: Command): Promise<void> {
  const resolved = await credentialsOf(command);
  const { apiUrl } = resolved;

  if (options.withKey) {
    const synced = await saveApiKey(apiUrl, options.withKey, resolved.namespaceId ?? undefined);
    emit({
      data: { connected: true, kind: "api_key", api_url: apiUrl, synced },
      text: () => console.log(`${good("Connected")} with that key. Saved to ${credentialsPath()}`),
    });
    return;
  }

  const memdot = MemDot.create({ baseUrl: apiUrl, client: CLIENT });
  const file = await loadCredentials();

  if (options.continue) {
    const pending = file?.pending;
    if (!pending) {
      throw new CliError("No login is waiting. Run memdot login.", EXIT.usage, "NO_PENDING");
    }
    const collected = await collect(memdot, pending, Number(options.wait) || CONTINUE_WAIT_SECONDS);
    if (!collected) {
      emit({
        data: { connected: false, state: "pending", url: pending.url, code: pending.code },
        text: () => console.log(`Still waiting for you to approve it at ${pending.url}`),
      });
      return;
    }
    const synced = await finishLogin(file, apiUrl, pending, collected);
    emit({
      data: {
        connected: true,
        agent_id: collected.agentId,
        namespace_id: collected.namespaceId,
        owner_account: collected.ownerAccount,
        synced,
      },
      text: () => {
        console.log(`${good("Connected")} to ${collected.ownerAccount ?? "your account"}.`);
        console.log(dim(`Saved to ${credentialsPath()}`));
      },
    });
    return;
  }

  const key = newAgentIdentity();
  const started = await memdot.agents.startConnect({
    publicKey: key.publicKey,
    label: options.label,
    client: clientName(),
  });
  const pending = pendingFrom(started, key, options.label);
  await saveCredentials({
    ...credentialsForApi(file, apiUrl),
    version: 1,
    api_url: apiUrl,
    pending,
  });

  // A coding agent's shell shows nothing until the command ends, so it gets the address first and
  // collects afterwards.
  if (options.wait === false || !interactive()) {
    emit({
      data: {
        connected: false,
        state: "pending",
        url: started.url,
        code: started.code,
        expires_at: started.expiresAt,
        next: "memdot login --continue --wait 120",
      },
      text: () => {
        console.log(`Open ${started.url}`);
        console.log(`Type this code there: ${strong(started.code)}`);
        console.log("Then come back and run:");
        console.log("  memdot login --continue");
      },
    });
    return;
  }

  console.error(`\nOpen ${started.url}`);
  console.error(`and type this code: ${strong(started.code)}\n`);
  if (options.browser !== false) openBrowser(started.url);
  say(dim("Waiting for you to approve it…"));
  const collected = await collect(memdot, pending, LOGIN_WAIT_SECONDS);
  if (!collected) {
    throw new CliError(
      "Nothing came back in time. Run memdot login again.",
      EXIT.auth,
      "CONNECT_EXPIRED",
    );
  }
  const synced = await finishLogin(await loadCredentials(), apiUrl, pending, collected);
  emit({
    data: {
      connected: true,
      agent_id: collected.agentId,
      namespace_id: collected.namespaceId,
      owner_account: collected.ownerAccount,
      synced,
    },
    text: () => {
      console.log(`${good("Connected")} to ${collected.ownerAccount ?? "your account"}.`);
      console.log(dim(`Saved to ${credentialsPath()}`));
      if (synced.length) console.log(dim(`Updated the key in ${synced.join(", ")}`));
      console.log(`\nTry: memdot add "I prefer short answers" -u me --no-infer`);
    },
  });
}

const defaultLabel = () => `${clientName()} on ${hostname()}`;

export function setupCommands(program: Command): void {
  program
    .command("login")
    .description("Connect this machine: you choose what it can reach, in your browser")
    .option("--label <name>", "what to call it", defaultLabel())
    .option("--with-key <key>", "use an API key you already have (Assisted only, no browser)")
    .option("--no-browser", "just print the address")
    .option("--no-wait", "print the address and return; finish later with --continue")
    .option("--continue", "collect a login started with --no-wait")
    .option("--wait <seconds>", "how long --continue waits", Number)
    .action(runLogin);

  program
    .command("init")
    .description("Set up this machine: the same as login, or --api-key to use a key you have")
    .action(async (_options, command: Command) => {
      const resolved = await credentialsOf(command);
      if (resolved.apiKey && resolved.apiKeySource !== "file") {
        const synced = await saveApiKey(
          resolved.apiUrl,
          resolved.apiKey,
          resolved.namespaceId ?? undefined,
        );
        emit({
          data: { connected: true, kind: "api_key", api_url: resolved.apiUrl, synced },
          text: () => console.log(`${good("Connected.")} Saved to ${credentialsPath()}`),
        });
        return;
      }
      if (resolved.apiKey) {
        emit({
          data: { connected: true, kind: "existing", api_url: resolved.apiUrl },
          text: () =>
            console.log("Already connected. To start over: memdot logout, then memdot login"),
        });
        return;
      }
      await runLogin({ label: defaultLabel() }, command);
    });

  program
    .command("logout")
    .description("Forget this machine's key. It keeps working elsewhere until you revoke it")
    .action(async () => {
      await removeCredentials();
      emit({
        data: { logged_out: true },
        text: () =>
          console.log("Forgotten here. To stop the key everywhere, revoke it under Agents."),
      });
    });

  program
    .command("whoami")
    .description("Who this machine is connected as")
    .action(async (_options, command: Command) => {
      const file = await loadCredentials();
      const { memdot, resolved } = await connect(command);
      const spaces = await memdot.spaces.list();
      const data = {
        api_url: resolved.apiUrl,
        key: redact(resolved.apiKey),
        key_source: resolved.apiKeySource,
        agent: file?.agent ? { id: file.agent.id, label: file.agent.label } : null,
        reads_private: memdot.account.unlocked || Boolean(resolved.identity),
        default_namespace_id: resolved.namespaceId,
        spaces: spaces.map((space) => ({ id: space.id, name: space.name })),
      };
      emit({
        data,
        text: () => {
          console.log(strong(data.agent?.label ?? "An API key"));
          console.log(dim(`${data.key} · ${resolved.apiUrl}`));
          console.log(
            data.reads_private
              ? "Holds its own key: it can read Private namespaces."
              : "Holds no key: Assisted namespaces only.",
          );
          for (const space of spaces)
            console.log(`  ${space.name ?? "(sealed)"}  ${dim(space.id)}`);
        },
      });
    });

  program
    .command("status")
    .description("Whether MemDot is reachable and this key works")
    .action(async (_options, command: Command) => {
      const resolved = await credentialsOf(command);
      const started = performance.now();
      const reachable = await fetch(new URL("/live", resolved.apiUrl))
        .then((response) => response.ok)
        .catch(() => false);
      const latency = Math.round(performance.now() - started);
      let key: "valid" | "invalid" | "none" = "none";
      if (reachable && resolved.apiKey) {
        const { memdot } = await connect(command);
        key = await memdot
          .usage()
          .then(() => "valid" as const)
          .catch(() => "invalid" as const);
      }
      const data = {
        api_url: resolved.apiUrl,
        reachable,
        latency_ms: latency,
        key,
        key_source: resolved.apiKeySource,
        version: VERSION,
      };
      emit({
        data,
        text: () => {
          console.log(
            `${reachable ? good("Reachable") : "Unreachable"}  ${resolved.apiUrl}  ${dim(`${latency} ms`)}`,
          );
          console.log(
            `Key: ${key}${resolved.apiKeySource ? dim(` (from ${resolved.apiKeySource})`) : ""}`,
          );
        },
      });
      if (!reachable) process.exitCode = EXIT.network;
      else if (key !== "valid") process.exitCode = EXIT.auth;
    });

  program
    .command("version")
    .description("This CLI's version")
    .action(() => {
      emit({ data: { version: VERSION }, text: () => console.log(VERSION) });
    });

  const config = program.command("config").description("What's saved on this machine");

  config
    .command("show")
    .description("Show it, with keys hidden")
    .action(async () => {
      const file = await loadCredentials();
      const resolved = resolveCredentials(file);
      emit({
        data: {
          path: credentialsPath(),
          api_url: resolved.apiUrl,
          api_key: redact(resolved.apiKey),
          agent: file?.agent ? { id: file.agent.id, label: file.agent.label } : null,
          namespace_id: resolved.namespaceId,
          user_id: resolved.userId,
          agent_id: resolved.agentId,
          run_id: resolved.runId,
        },
      });
    });

  const SETTABLE: Record<string, (file: Credentials, value: string) => void> = {
    api_url: (file, value) => {
      file.api_url = value;
    },
    namespace_id: (file, value) => {
      file.namespace_id = value;
    },
    user_id: (file, value) => {
      file.defaults = { ...file.defaults, user_id: value };
    },
    agent_id: (file, value) => {
      file.defaults = { ...file.defaults, agent_id: value };
    },
    run_id: (file, value) => {
      file.defaults = { ...file.defaults, run_id: value };
    },
  };

  config
    .command("get")
    .description("Read one setting")
    .argument("<key>", Object.keys(SETTABLE).join(", "))
    .action(async (key: string) => {
      if (!(key in SETTABLE)) {
        throw new CliError(
          `Unknown setting. Use ${Object.keys(SETTABLE).join(", ")}.`,
          EXIT.usage,
          "BAD_KEY",
        );
      }
      const resolved = resolveCredentials(await loadCredentials());
      const value = {
        api_url: resolved.apiUrl,
        namespace_id: resolved.namespaceId,
        user_id: resolved.userId,
        agent_id: resolved.agentId,
        run_id: resolved.runId,
      }[key];
      emit({ data: { key, value }, text: () => console.log(value ?? "") });
    });

  config
    .command("set")
    .description("Save one setting")
    .argument("<key>", Object.keys(SETTABLE).join(", "))
    .argument("<value>")
    .action(async (key: string, value: string) => {
      const set = SETTABLE[key];
      if (!set) {
        throw new CliError(
          `Unknown setting. Use ${Object.keys(SETTABLE).join(", ")}.`,
          EXIT.usage,
          "BAD_KEY",
        );
      }
      const saved: Credentials = (await loadCredentials()) ?? {
        version: 1,
        api_url: resolveCredentials(null).apiUrl,
      };
      // Moving to another address leaves this one's key behind, or the next command would send it.
      const file = (key === "api_url" ? credentialsForApi(saved, value) : saved) as Credentials;
      set(file, value);
      await saveCredentials(file);
      emit({ data: { key, value }, text: () => console.log(`${key} = ${value}`) });
    });
}
