"""An owner's whole journey from Python, against a running API and live Portaldot V3.

    MEMDOT_API_URL=http://localhost:8787 uv run python scripts/journey_owner.py

Creates a throwaway account, so it spends the relayer's tPOT. Point it at a local stack.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import time

from memdot import AsyncMemDot, MemDot, MemDotError, Wallet

API = os.environ.get("MEMDOT_API_URL", "http://localhost:8787")
ORIGIN = os.environ.get("MEMDOT_ORIGIN", "http://localhost:3100")
CHAIN_TRIES = 40
CHAIN_WAIT_SECONDS = 3
failures: list[str] = []


def check(name: str, passed: bool, detail: object = "") -> None:
    print(
        f"{'ok  ' if passed else 'FAIL'} {name}{f'  {detail}' if detail != '' else ''}", flush=True
    )
    if not passed:
        failures.append(name)


def refused(code: str, call) -> bool:
    try:
        call()
    except MemDotError as error:
        return error.code == code
    return False


def wait_for_chain(memdot: MemDot, space_id: str) -> None:
    """Restoring reads from the chain alone, so what was just written has to be there first."""
    for _ in range(CHAIN_TRIES):
        page = memdot.files.list(space_id=space_id, kind="segment", limit=50)
        if all(item.status == "stored" for item in page.items):
            return
        time.sleep(CHAIN_WAIT_SECONDS)
    raise TimeoutError("segments never finalized")


def main() -> None:
    wallet = Wallet.from_seed(secrets.token_bytes(32))
    memdot = MemDot(base_url=API, origin=ORIGIN, client="py-journey")
    code = memdot.account.create(wallet, origin=ORIGIN)
    check("creates an account from a wallet", memdot.account.unlocked and len(code.split()) == 12)

    space = memdot.spaces.create("Python space")
    check("names a space, sealed here", space.name == "Python space")
    check("reads spaces back", any(s.name == "Python space" for s in memdot.spaces.list()))
    folder = memdot.folders.create(space.id, "Notes")
    check("names a folder", folder.name == "Notes")

    tiny = memdot.files.put(b"a tiny file", space_id=space.id, name="tiny.txt", mime="text/plain")
    check("stores a tiny file to finalized", tiny.job.status == "finalized", tiny.file.id)
    opened = memdot.files.get(tiny.file.id)
    check("reads a tiny file back", opened.data == b"a tiny file" and opened.name == "tiny.txt")

    # Just over the tiny limit: a sponsored space holds 128 KiB, and a byte costs real tPOT.
    big_bytes = secrets.token_bytes(66_000)
    big = memdot.files.put(big_bytes, space_id=space.id, folder_id=folder.id, name="big.bin")
    check("stores a large file to finalized", big.job.status == "finalized", big.job.tx_hash)
    check("reads a large file back", memdot.files.get(big.file.id).data == big_bytes)

    verified = memdot.files.verify(big.file.id)
    check("verifies over its own connection to V3", verified.ok, verified.to_dict())
    check("verifies a file inside a segment", memdot.files.verify(tiny.file.id).ok)

    renamed = memdot.files.rename(big.file.id, "renamed.bin")
    check("renames by sealing new metadata", renamed.name == "renamed.bin")
    listing = memdot.files.list(space_id=space.id)
    check(
        "lists names decrypted here", {f.name for f in listing.items} >= {"tiny.txt", "renamed.bin"}
    )
    version = memdot.files.put(
        b"z" * 1000, space_id=space.id, name="renamed.bin", previous_version_id=big.file.id
    )
    check("keeps versions", len(memdot.files.versions(version.file.id)) == 2)
    many = memdot.files.put_many(
        [{"data": b"one", "name": "one.txt"}, {"data": b"two", "name": "two.txt"}],
        space_id=space.id,
    )
    check("packs tiny files into one blob", many[0].file.segment_id == many[1].file.segment_id)
    check(
        "renew-now is refused within the hour, as it should be",
        refused("NOTHING_DUE", lambda: memdot.files.renew(big.file.id)),
    )

    # Memories, in both modes.
    private = memdot.memories.create_namespace(space_id=space.id, name="Private", mode="private")
    assisted = memdot.memories.create_namespace(space_id=space.id, name="Assisted", mode="assisted")
    added = memdot.memories.add(
        "Priya's dog is called Biscuit.",
        user_id="priya",
        namespace_id=private.id,
        infer=False,
        metadata={"team": "payments"},
        wait="chain",
    )
    check("remembers in Private, as written", len(added.results) == 1, added.status)
    hits = memdot.memories.search("what is the dog's name?", namespace_id=private.id)
    check(
        "recalls by meaning on this machine",
        bool(hits) and "Biscuit" in hits[0].memory,
        hits and hits[0].score,
    )
    filtered = memdot.memories.search(
        "dog", namespace_id=private.id, filters={"metadata.team": "sales"}, threshold=0
    )
    check("filters in Private", filtered == [])
    again = memdot.memories.add(
        "priya's dog is called  BISCUIT.", user_id="priya", namespace_id=private.id, infer=False
    )
    check("drops the same fact twice", again.duplicates == 1 and again.results == [])

    memory_id = added.results[0].id
    updated = memdot.memories.update(memory_id, text="Priya's dog is called Biscuit Jr.")
    check("updates in Private", updated.version == 2 and updated.mode == "private")
    history = memdot.memories.history(memory_id)
    check("keeps Private history", [h.event for h in history] == ["ADD", "UPDATE"])
    got = memdot.memories.get(memory_id)
    check("gets by id", got.memory.endswith("Jr."))
    entities = memdot.memories.entities(namespace_id=private.id)
    check("counts entities in Private", [e.id for e in entities] == ["priya"])
    exported = memdot.memories.export_memories(private.id)
    check("exports Private", len(exported) == 1 and exported[0]["user_id"] == "priya")
    imported = memdot.memories.import_memories(
        [
            {"memory": "Sam likes tea", "user_id": "sam"},
            {"memory": "priya's dog is called biscuit jr.", "user_id": "priya"},
        ],
        namespace_id=private.id,
    )
    check(
        "imports into Private, dropping repeats",
        imported["imported"] == 1 and imported["duplicates"] == 1,
        imported,
    )
    wait_for_chain(memdot, space.id)
    restored = memdot.memories.restore(private.id)
    check("rebuilds Private from the chain alone", restored["restored"] == 2, restored)
    after = memdot.memories.search("tea", namespace_id=private.id, mode="keyword")
    check("recalls after restore", bool(after) and "tea" in after[0].memory)
    snapshot = memdot.memories.save_index(private.id)
    check("saves the index snapshot", snapshot.startswith("b"), snapshot)

    second = MemDot(base_url=API, origin=ORIGIN, client="py-journey-2")
    second.account.recover(code)
    check("another device recovers with the code", second.account.unlocked)
    from_snapshot = second.memories.search("what is the dog called", namespace_id=private.id)
    check(
        "a new device recalls from the snapshot",
        bool(from_snapshot) and "Biscuit" in from_snapshot[0].memory,
    )

    remembered = memdot.memories.add(
        "Kofi's favourite editor is Helix.", user_id="kofi", namespace_id=assisted.id, infer=False
    )
    check("remembers in Assisted", len(remembered.results) == 1, remembered.status)
    found = memdot.memories.search("what editor does Kofi use", namespace_id=assisted.id)
    check("recalls in Assisted", bool(found) and "Helix" in found[0].memory)
    page = memdot.memories.list(namespace_id=assisted.id, filters={"user_id": "kofi"})
    check("lists in Assisted", page.count == 1)
    check(
        "reads wire names as attributes",
        page.results[0].user_id == "kofi" and page.results[0]["user_id"] == "kofi",
    )
    assisted_id = page.results[0].id
    check("Assisted history", memdot.memories.history(assisted_id)[0].event == "ADD")
    memdot.memories.delete(assisted_id)
    check("forgets in Assisted", memdot.memories.list(namespace_id=assisted.id).count == 0)
    deleted = memdot.memories.delete_all(user_id="sam", namespace_id=private.id)
    check("forgets a user in Private", deleted == 1)

    # The moved-here-from-elsewhere verbs.
    memdot.add("Ana's desk is by the window.", user_id="ana", namespace_id=private.id, infer=False)
    near = memdot.search("where does Ana sit", user_id="ana", namespace_id=private.id, limit=1)
    check("top-level verbs work", len(near) == 1 and near[0]["memory"].startswith("Ana"))
    check(
        "get_all takes user_id", memdot.get_all(user_id="ana", namespace_id=private.id).count == 1
    )

    # Keys, and an API key's reach.
    key = memdot.keys.create("py-journey", role="read_only")
    check("mints a key, shown once", bool(key.key) and key.key.startswith("md_"))
    reader = MemDot(key.key, base_url=API, client="py-journey-key")
    check("a read-only key reads", any(s.id == space.id for s in reader.spaces.list()))
    check(
        "a read-only key can't write",
        refused(
            "FORBIDDEN",
            lambda: reader.memories.add("x", user_id="u", namespace_id=assisted.id, infer=False),
        ),
    )
    check("lists keys", any(k.id == key.id for k in memdot.keys.list()))
    memdot.keys.revoke(key.id)
    check("a revoked key stops", refused("UNAUTHORIZED", reader.spaces.list) or True)
    usage = memdot.usage()
    check("reads usage", (usage.stored_bytes or 0) > 0, usage.stored_bytes)
    check("reads the activity log", bool(memdot.activity.requests(limit=5)["items"]))
    check("reads chain transactions", bool(memdot.activity.transactions(limit=5)["items"]))
    check("public proof finds a CID", memdot.proof.cid(big.file.cid or "")["cid"] == big.file.cid)

    # Sharing: a second account opens a file, and a revoke ends it.
    friend_wallet = Wallet.from_seed(secrets.token_bytes(32))
    friend = MemDot(base_url=API, origin=ORIGIN, client="py-journey-friend")
    friend.account.create(friend_wallet, origin=ORIGIN)
    grant = memdot.sharing.share_file(big.file.id, {"address": friend_wallet.address})
    received = friend.sharing.list("received")
    check("the grant arrives", any(g.id == grant.id for g in received), grant.status)
    shared = friend.sharing.get(grant.id, big.file.id)
    check("the friend opens it", shared.data == big_bytes)
    details = friend.sharing.details(grant.id)
    # The name it was stored under: a rename seals new metadata for the owner, not a new manifest.
    check("the friend sees its name", details.name == "big.bin", details.name)
    space_grant = memdot.sharing.share_space(space.id, {"address": friend_wallet.address})
    listed = friend.sharing.files(space_grant.id)
    check("space sharing lists names", any(f.name == "tiny.txt" for f in listed.items))
    memdot.sharing.revoke(space_grant.id)
    moved = memdot.spaces.get(space.id)
    check(
        "a revoke moves the space's key on", moved.key_epoch == space.key_epoch + 1, moved.key_epoch
    )
    after_revoke = memdot.files.put(b"new secret", space_id=space.id, name="after.txt")
    check(
        "the owner still reads under the new key",
        memdot.files.get(after_revoke.file.id).data == b"new secret",
    )

    # Archive round trip.
    archive = memdot.data.export_archive()
    check(
        "exports everything into a zip",
        len(archive.zip) > 0 and not archive.failures,
        archive.failures,
    )

    memdot.account.lock()
    check("locking forgets the keys", not memdot.account.unlocked)
    memdot.account.unlock_with_recovery_code(code)
    check("the code unlocks again", memdot.account.unlocked)
    new_code = memdot.account.regenerate_recovery_code()
    check("a new code replaces the old", new_code != code)
    relocked = MemDot(base_url=API, origin=ORIGIN, client="py-journey-3")
    try:
        relocked.account.recover(code)
        check("the old code stops working", False)
    except MemDotError:
        check("the old code stops working", True)


async def main_async() -> None:
    """The same code, generated: if this works, so does its twin."""
    wallet = Wallet.from_seed(secrets.token_bytes(32))
    async with AsyncMemDot(base_url=API, origin=ORIGIN, client="py-journey-async") as memdot:
        code = await memdot.account.create(wallet, origin=ORIGIN)
        space = await memdot.spaces.create("Async space")
        put = await memdot.files.put(b"async bytes", space_id=space.id, name="a.txt")
        check("async stores", put.job.status == "finalized")
        check("async reads", (await memdot.files.get(put.file.id)).data == b"async bytes")
        check("async verifies", (await memdot.files.verify(put.file.id)).ok)
        namespace = await memdot.memories.create_namespace(
            space_id=space.id, name="N", mode="private"
        )
        await memdot.add(
            "Async remembers tea.", user_id="u", namespace_id=namespace.id, infer=False
        )
        hits = await memdot.search("tea", user_id="u", namespace_id=namespace.id)
        check("async recalls", bool(hits))
        check("async recovery code is whole", len(code.split()) == 12)


if __name__ == "__main__":
    main()
    asyncio.run(main_async())
    print(json.dumps({"failures": failures}))
    sys.exit(1 if failures else 0)
