"""Both CLIs offer the same commands and flags: the tree Node prints, against the tree Python prints.

`tests/vectors/node-cli-help.json` is what `memdot help --json` printed from Node, written by
`pnpm --filter @memdot/sdk vectors:python`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from memdot.cli import cli, hoist_globals, main

NODE = json.loads((Path(__file__).parent / "vectors" / "node-cli-help.json").read_text("utf8"))


def python_tree() -> dict:
    result = CliRunner().invoke(cli, ["help", "--json"])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


def flatten(tree: dict) -> dict[str, dict]:
    found = {tree["name"]: tree}
    for child in tree.get("subcommands", []):
        found.update(flatten(child))
    return found


NODE_COMMANDS = flatten(NODE)
PY_COMMANDS = flatten(python_tree())


def test_the_same_commands():
    assert sorted(PY_COMMANDS) == sorted(NODE_COMMANDS)


@pytest.mark.parametrize("name", sorted(NODE_COMMANDS))
def test_the_same_shape(name: str):
    node, python = NODE_COMMANDS[name], PY_COMMANDS[name]
    assert python["description"] == node["description"]
    assert python.get("destructive") == node.get("destructive")
    assert [(a["name"], a["required"]) for a in python["arguments"]] == [
        (a["name"], a["required"]) for a in node["arguments"]
    ]
    # Commander words a repeating argument with dots in its name.
    node_flags = {o["flags"]: o for o in node["options"]}
    python_flags = {o["flags"]: o for o in python["options"]}
    assert sorted(python_flags) == sorted(node_flags)
    for flags, option in node_flags.items():
        assert python_flags[flags]["description"] == option["description"]


def test_the_same_exit_codes_and_envelope():
    tree = python_tree()
    assert tree["exit_codes"] == NODE["exit_codes"]
    assert tree["envelope"] == NODE["envelope"]


def test_global_flags_work_anywhere():
    assert hoist_globals(["search", "tea", "-u", "priya", "--json", "-k", "3"]) == [
        "-u",
        "priya",
        "--json",
        "search",
        "tea",
        "-k",
        "3",
    ]
    assert hoist_globals(["add", "--", "-u", "x"]) == ["add", "--", "-u", "x"]


def run(capsys: pytest.CaptureFixture, *args: str) -> tuple[int, str]:
    with pytest.raises(SystemExit) as leaving:
        main(list(args))
    return leaving.value.code, capsys.readouterr().out


def test_a_usage_error_is_an_envelope_with_code_2(capsys):
    code, out = run(capsys, "--agent", "no-such-command")
    answer = json.loads(out)
    assert code == 2
    assert answer["status"] == "error" and answer["error"]["code"] == "USAGE"


def test_not_connected_says_what_to_do(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("MEMDOT_CREDENTIALS_DIR", str(tmp_path))
    monkeypatch.delenv("MEMDOT_API_KEY", raising=False)
    monkeypatch.delenv("MEMDOT_RECOVERY_CODE", raising=False)
    code, out = run(capsys, "search", "tea", "--agent")
    answer = json.loads(out)
    assert code == 3
    assert answer["error"]["code"] == "NOT_CONNECTED"
    assert answer["error"]["hint"] == "Run: memdot login"


def test_destructive_needs_force_without_a_person(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("MEMDOT_CREDENTIALS_DIR", str(tmp_path))
    code, out = run(capsys, "file", "revoke", "abc", "--agent")
    answer = json.loads(out)
    assert code == 5
    assert answer["error"]["code"] == "CONFIRMATION_REQUIRED"


def test_config_round_trips_the_same_file(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("MEMDOT_CREDENTIALS_DIR", str(tmp_path))
    code, _ = run(capsys, "config", "set", "user_id", "priya", "--agent")
    assert code == 0
    saved = json.loads((tmp_path / "credentials.json").read_text())
    assert saved["defaults"]["user_id"] == "priya"
    assert (tmp_path / "credentials.json").stat().st_mode & 0o777 == 0o600
    code, out = run(capsys, "config", "get", "user_id", "--agent")
    assert json.loads(out)["data"] == {"key": "user_id", "value": "priya"}


def test_changing_the_address_leaves_the_key_behind(capsys, monkeypatch, tmp_path):
    monkeypatch.setenv("MEMDOT_CREDENTIALS_DIR", str(tmp_path))
    (tmp_path / "credentials.json").write_text(
        json.dumps({"version": 1, "api_url": "https://api.a.test", "api_key": "md_a"})
    )
    run(capsys, "config", "set", "api_url", "https://evil.test", "--agent")
    saved = json.loads((tmp_path / "credentials.json").read_text())
    assert saved["api_url"] == "https://evil.test" and "api_key" not in saved
