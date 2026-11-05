#!/usr/bin/env bash
# Every recipe in the README, end to end, cleaning up after itself. Stops at the first one that fails.
# Needs memdot, jq, and a connection: memdot login, or MEMDOT_API_KEY plus MEMDOT_AGENT_IDENTITY.
# Set MEMDOT_NAMESPACE to an Assisted namespace, and SPACE to run the file recipes.

set -euo pipefail

MEMDOT="${MEMDOT:-memdot}"
ME="cookbook-$RANDOM$RANDOM"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; "$MEMDOT" delete --all -u "$ME" --force >/dev/null 2>&1 || true' EXIT

say() { printf '\n── %s\n' "$1"; }
expect() { # what, got, wanted
  case "$2" in
    *"$3"*) printf '✓ %s\n' "$1" ;;
    *) printf '✗ %s: wanted "%s", got: %s\n' "$1" "$3" "$2"; exit 1 ;;
  esac
}

say "Remember something, exactly as written"
"$MEMDOT" add "Priya reviews pull requests on Tuesdays" -u "$ME" --no-infer >/dev/null

say "Find it by what it means"
found="$("$MEMDOT" --agent search "when does Priya look at code?" -u "$ME" --fields memory,score)"
expect "search finds it" "$(jq -r '.data[0].memory' <<<"$found")" "Tuesdays"

say "Read a field in a script"
id="$("$MEMDOT" --agent list -u "$ME" | jq -r '.data.results[0].id')"
expect "list gives its ID" "$id" "-"

say "Correct it, and see what changed"
"$MEMDOT" update "$id" "Priya reviews pull requests on Thursdays" >/dev/null
history="$("$MEMDOT" --agent history "$id")"
expect "history keeps the old version" "$(jq -r '.data[-1].old_memory' <<<"$history")" "Tuesdays"
expect "and the new one" "$(jq -r '.data[-1].new_memory' <<<"$history")" "Thursdays"

say "Keep metadata, and filter on it"
"$MEMDOT" add "The staging database is called bluefin" -u "$ME" --no-infer -m '{"env":"staging"}' >/dev/null
filtered="$("$MEMDOT" --agent list --filter '{"AND":[{"user_id":"'"$ME"'"},{"metadata.env":"staging"}]}')"
expect "the filter finds it" "$(jq -r '.data.results[0].memory' <<<"$filtered")" "bluefin"

say "Pipe text in"
echo "Deploys are frozen on the last day of the month" | "$MEMDOT" add -u "$ME" --no-infer >/dev/null
piped="$("$MEMDOT" --agent search "when are deploys frozen?" -u "$ME" --fields memory)"
expect "piped text is there" "$(jq -r '.data[0].memory' <<<"$piped")" "frozen"

say "Tell failures apart by exit code"
set +e
"$MEMDOT" --agent get 00000000-0000-4000-8000-000000000000 >/dev/null
code=$?
set -e
expect "not found is exit 4" "$code" "4"

say "Back up what's there"
"$MEMDOT" export --out "$WORK/backup.json" >/dev/null
expect "the export holds it" "$(cat "$WORK/backup.json")" "bluefin"

if [ -n "${SPACE:-}" ]; then
  say "Encrypt a file and store it on Portaldot V3"
  printf 'The cellar key is under the third brick.\n' >"$WORK/note.txt"
  "$MEMDOT" --agent file put "$WORK/note.txt" --space "$SPACE" --dry-run | jq -r '"Would cost " + .data.tpot'
  stored="$("$MEMDOT" --agent file put "$WORK/note.txt" --space "$SPACE")"
  file="$(jq -r '.data.id' <<<"$stored")"
  expect "it's finalized" "$(jq -r '.data.status' <<<"$stored")" "finalized"
  jq -r '"Transaction " + .data.tx_hash' <<<"$stored"

  say "Check it against the chain, from this machine"
  expect "the chain has it" "$("$MEMDOT" --agent file verify "$file" | jq -r '.data.ok')" "true"

  say "Fetch and decrypt it"
  expect "same text" "$("$MEMDOT" file get "$file" --stdout)" "third brick"

  say "Delete it"
  "$MEMDOT" file rm "$file" --force >/dev/null
fi

say "See what a delete would take, then do it"
expect "dry run counts them" "$("$MEMDOT" --agent delete --all -u "$ME" --dry-run | jq -r '.data.would_delete')" "3"
expect "then they're gone" "$("$MEMDOT" --agent delete --all -u "$ME" --force | jq -r '.data.deleted')" "3"

printf '\nEvery recipe worked.\n'
