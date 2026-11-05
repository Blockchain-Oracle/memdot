# CLI cookbook

Recipes for `memdot` in a terminal or a script. [`cookbook.sh`](cookbook.sh) runs all of them against the real service and cleans up after itself.

## Set up

```bash
npm install -g https://app.84.46.247.92.sslip.io/cli/memdot-cli.tgz
memdot login
```

Run every recipe. It needs [`jq`](https://jqlang.org). Set `SPACE` to include the file recipes, which store one small file on chain:

```bash
SPACE=your-space-id ./cookbook.sh
```

`memdot space ls` shows your spaces. `MEMDOT_NAMESPACE` picks where memories go, and it should be an Assisted namespace, since these recipes search on the server unless the model is on your machine.

## Remember and find

```bash
memdot add "Priya reviews pull requests on Tuesdays" -u priya --no-infer
memdot search "when does Priya look at code?" -u priya
```

`--no-infer` keeps the text as written and spends no model call. Leave it off to have a model pull out the facts. `-u` is who it's about, and passing it on a search keeps other people's memories out.

## Use it in a script

`--agent` makes stdout exactly one JSON envelope, with progress on stderr:

```bash
memdot --agent search "when does Priya look at code?" -u priya --fields memory,score | jq -r '.data[0].memory'
memdot --agent list -u priya | jq -r '.data.results[0].id'
```

Exit codes tell failures apart, so a script doesn't have to read messages:

| Exit | Means |
|---|---|
| 0 | It worked |
| 1 | Something else failed |
| 2 | Bad usage |
| 3 | Not connected, or the key stopped working |
| 4 | Not found |
| 5 | Conflict, or a confirmation is needed |
| 6 | Over a limit |
| 7 | Network |

## Correct something

```bash
memdot update <id> "Priya reviews pull requests on Thursdays"
memdot history <id>
```

The old version stays in the history.

## Metadata and filters

```bash
memdot add "The staging database is called bluefin" -u priya --no-infer -m '{"env":"staging"}'
memdot search "staging database" --filter '{"AND":[{"user_id":"priya"},{"metadata.env":"staging"}]}'
```

Filters nest `AND`, `OR` and `NOT` to any depth.

## Pipe things in

```bash
echo "Deploys are frozen on the last day of the month" | memdot add -u priya --no-infer
git log -1 --format=%B | memdot add -u priya
```

## Back up and restore

```bash
memdot export --out backup.json
memdot import backup.json
```

Importing the same file twice doesn't duplicate anything. `memdot import` also reads a Mem0 export.

## Encrypted files

```bash
memdot file put note.txt --space <id> --dry-run
memdot file put note.txt --space <id>
memdot file verify <file-id>
memdot file get <file-id> --stdout
memdot file rm <file-id> --force
```

`--dry-run` says what it would cost. `verify` asks Portaldot V3 from your machine, not MemDot, so it doesn't depend on trusting us.

## Forget

```bash
memdot delete --all -u priya --dry-run
memdot delete --all -u priya --force
```

Anything that can't be undone asks first, or needs `--force` when no person is there to ask.

## Connect somewhere else

For a server, CI or n8n: this prints the credentials and saves nothing here, and you can revoke that connection separately under Agents. It's for a person at a terminal, since it prints a key.

```bash
(umask 077; memdot login --print-env --label ci >> .env)
```

The `umask` keeps the file readable only by you.

Every command and flag: `memdot help --json`, or the [`memdot-cli` skill](../../skills/memdot-cli/references/commands.md).
