"""What TypeScript made, opened and recomputed here, and what Python seals for TypeScript to open."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path

import pytest

from memdot import crypto
from memdot.chain import cid_of, content_hash
from memdot.crypto import SpaceKey
from memdot.engine import (
    PROMPTS,
    LocalIndex,
    combine_scores,
    decode_entry,
    dedupe_key,
    encode_entry,
    entity_candidates,
    matches_filter,
    normalize_bm25,
    normalize_entity,
    normalize_text,
    parse_filter,
    parse_memory_import,
    query_term_count,
    rank,
    read_snapshot,
    term_frequencies,
    tokenize,
)
from memdot.engine.filters import FilterError
from memdot.engine.tokenize import STOPWORDS

HERE = Path(__file__).parent / "vectors"
V = json.loads((HERE / "ts-vectors.json").read_text("utf8"))
AMK = bytes.fromhex(V["amk"])
SEED = bytes.fromhex(V["seed"])


def b64(value: str) -> bytes:
    return base64.b64decode(value)


def test_keys_derive_the_same():
    keys = V["keys"]
    assert crypto.user_key_pair(AMK)[1].hex() == keys["userPublicKey"]
    assert crypto.user_recipient(AMK) == keys["userRecipient"]
    assert crypto.user_identity(AMK) == keys["userIdentity"]
    secret_key, public_key = crypto.x25519_from_seed(SEED, crypto.INFO["object"])
    assert crypto.age_recipient(public_key) == keys["ageRecipient"]
    assert crypto.age_identity(secret_key) == keys["ageIdentity"]
    assert crypto.public_key_from_age_recipient(keys["ageRecipient"]) == public_key
    assert crypto.owner_seed(AMK).hex() == keys["ownerSeed"]
    assert crypto.object_identity(bytes.fromhex(keys["objectKey"])) == keys["objectIdentity"]


def test_recovery_code():
    keys = V["keys"]
    code = V["recoveryCode"]
    assert crypto.recovery_secret(code).hex() == keys["recoverySecret"]
    assert crypto.recovery_secret(f"  {code.upper()}  ").hex() == keys["recoverySecret"]
    signing_key = crypto.recovery_sign_in_key(code)
    assert bytes(signing_key.verify_key).hex() == keys["recoverySignInPublicKey"]
    assert crypto.sign_recovery_challenge(code, b"challenge-123").hex() == keys["recoverySignature"]
    assert not crypto.is_valid_recovery_code("legal winner thank year wave")


def test_space_keys():
    space = V["space"]
    key = crypto.derive_space_key(AMK, space["id"], space["epoch"])
    assert key.key.hex() == space["key"]
    assert crypto.space_identity(key) == space["identity"]
    assert crypto.space_recipient(key) == space["recipient"]
    all_keys = crypto.derive_space_keys(AMK, space["id"], space["epoch"])
    assert [k.key.hex() for k in all_keys] == space["allEpochs"]


def test_grant_tag():
    grant = V["grantTag"]["grant"]
    assert (
        crypto.grant_tag(
            AMK,
            space_id=grant["spaceId"],
            object_id=grant["objectId"],
            grantee_kind=grant["granteeKind"],
            grantee=grant["grantee"],
            scope=grant["scope"],
        )
        == V["grantTag"]["tag"]
    )


def test_opens_what_typescript_sealed():
    sealed = V["sealed"]
    space = V["space"]
    identity = crypto.user_identity(AMK)
    assert (
        crypto.open_with(b64(sealed["age"]["sealed"]), identity).decode()
        == sealed["age"]["plaintext"]
    )
    assert crypto.open_with(b64(sealed["twoRecipients"]), identity) == b"for both"
    assert crypto.open_with(b64(sealed["twoRecipients"]), space["identity"]) == b"for both"

    space_id, keyring = crypto.open_space_keyring(b64(sealed["keyring"]), sealed["keyringIdentity"])
    assert space_id == space["id"]
    assert [k.key.hex() for k in keyring] == space["allEpochs"]
    assert crypto.keyring_identities(keyring)[0] == space["identity"]

    entries = crypto.open_segment(b64(sealed["segment"]), space["identity"])
    assert [e.kind for e in entries] == ["memory", "file"]
    assert decode_entry(entries[0].data)["text"] == json.loads(sealed["entry"])["text"]
    assert entries[1].data == b"a tiny file" and entries[1].name == "note.txt"

    manifest = crypto.open_manifest(b64(sealed["manifest"]), space["identity"])
    chunks = [b64(chunk) for chunk in sealed["objectChunks"]]
    assert [c["cid"] for c in manifest["chunks"]] == [cid_of(c) for c in chunks]
    data = crypto.decrypt_object(chunks, crypto.manifest_object_key(manifest), manifest["size"])
    assert len(data) == sealed["objectBytes"]
    assert f"0x{hashlib.blake2b(data, digest_size=32).hexdigest()}" == sealed["objectSha"]


def test_wrong_key_says_so():
    with pytest.raises(crypto.WrongKeyError):
        crypto.open_with(b64(V["sealed"]["age"]["sealed"]), crypto.user_identity(SEED))


def test_key_bundle():
    bundle = crypto.parse_key_bundle(V["keyBundle"].encode())
    secret = crypto.recovery_secret(V["recoveryCode"])
    assert crypto.unwrap_master_key(bundle, "recovery", secret) == AMK
    with pytest.raises(crypto.WrongKeyError):
        crypto.unwrap_master_key(bundle, "recovery", bytes(16))


def test_formats_round_trip_here():
    key = crypto.derive_space_key(AMK, V["space"]["id"], 1)
    recipient = crypto.space_recipient(key)
    identity = crypto.space_identity(key)
    entries = [crypto.SegmentEntry(id="x", kind="file", name="a", mime="b/c", data=b"123")]
    opened = crypto.open_segment(crypto.seal_segment(entries, recipient), identity)
    assert opened[0].data == b"123"

    encrypted = crypto.encrypt_object(b"z" * 70_000, 30_000)
    assert len(encrypted.chunks) == 3
    assert crypto.decrypt_object(encrypted.chunks, encrypted.object_key, 70_000) == b"z" * 70_000


def test_cid_and_padding():
    for case in V["cid"]:
        data = case["text"].encode()
        assert content_hash(data).hex() == case["contentHash"]
        assert cid_of(data) == case["cid"]
    for length, padded in V["padme"]:
        assert crypto.padme_length(length) == padded


def test_text_and_dedupe():
    for text, normalized in V["normalizeText"]:
        assert normalize_text(text) == normalized
    for case in V["dedupe"]:
        assert dedupe_key(case["text"], case["scope"]) == case["key"]
    assert json.loads(encode_entry(json.loads(V["sealed"]["entry"]))) == json.loads(
        V["sealed"]["entry"]
    )
    assert encode_entry(json.loads(V["sealed"]["entry"])).decode() == V["sealed"]["entry"]


def test_tokenize():
    for case in V["tokenize"]:
        assert tokenize(case["text"]) == case["tokens"], case["text"]
        assert term_frequencies(case["text"]) == case["frequencies"]
        assert query_term_count(case["text"]) == case["queryTerms"]
        assert entity_candidates(case["text"]) == case["entities"]
        assert normalize_entity(case["text"]) == case["normalizedEntity"]


def test_scoring():
    for raw, terms, expected in V["bm25Curve"]:
        assert normalize_bm25(raw, terms) == pytest.approx(expected)
    for case in V["combine"]:
        assert combine_scores(**case["parts"]) == pytest.approx(case["score"])
    candidates = [
        {"id": "a", "semantic": 0.8, "keyword": 3, "entity": 0},
        {"id": "b", "semantic": 0.1, "keyword": 8, "entity": 0.5},
        {"id": "c", "semantic": None, "keyword": 6, "entity": 0},
        {"id": "d", "semantic": None, "keyword": 0, "entity": 0},
        {"id": "e", "semantic": 0.4, "keyword": 0, "entity": 0},
    ]
    for case in V["rank"]:
        ranked = rank(candidates, query_terms=3, limit=4, threshold=0.3, mode=case["mode"])
        assert [hit["id"] for hit in ranked] == [hit["id"] for hit in case["ranked"]]
        for ours, theirs in zip(ranked, case["ranked"], strict=True):
            assert ours["score"] == pytest.approx(theirs["score"])


def _index() -> LocalIndex:
    index = LocalIndex("Xenova/all-MiniLM-L6-v2", "q8", 4)
    for i, (memory_id, text) in enumerate(V["index"]["corpus"]):
        vector = [1 if i == 0 else 0, 0.6 if i == 1 else 0, -0.8 if i == 2 else 0, 0.5]
        length = sum(v * v for v in vector) ** 0.5
        index.put(memory_id, i + 1, text, [v / length for v in vector])
    return index


def test_local_index_matches():
    index = _index()
    keyword = index.keyword(tokenize("payments team fridays"), 10)
    assert [hit["id"] for hit in keyword] == [hit["id"] for hit in V["index"]["keyword"]]
    for ours, theirs in zip(keyword, V["index"]["keyword"], strict=True):
        assert ours["score"] == pytest.approx(theirs["score"])
    semantic = index.semantic([1, 0, 0, 0], 10)
    assert [hit["id"] for hit in semantic] == [hit["id"] for hit in V["index"]["semantic"]]
    for ours, theirs in zip(semantic, V["index"]["semantic"], strict=True):
        assert ours["score"] == pytest.approx(theirs["score"])


def test_snapshot_is_the_same_bytes():
    snapshot = _index().to_snapshot("2026-11-02T10:00:00.000Z")
    assert snapshot == b64(V["index"]["snapshot"])
    read = read_snapshot(snapshot, model_id="Xenova/all-MiniLM-L6-v2", dtype="q8", dimensions=4)
    assert read is not None and read["a"][0] == 1
    assert read_snapshot(snapshot, model_id="other", dtype="q8", dimensions=4) is None


def test_filters():
    for case in V["filters"]["cases"]:
        assert (
            matches_filter(V["filters"]["memory"], parse_filter(case["filter"])) == case["matches"]
        ), case["filter"]
    for case in V["filters"]["refused"]:
        with pytest.raises(FilterError) as caught:
            parse_filter(case["filter"])
        assert str(caught.value) == case["error"]


def test_imports():
    for case in V["imports"]:
        assert parse_memory_import(case["input"]) == case["parsed"]


def test_prompts_are_the_ones_typescript_uses():
    assert PROMPTS["EXTRACTION_SYSTEM"].startswith("You turn a conversation")
    assert len(PROMPTS["DEFAULT_CATEGORIES"]) == 15


def test_embedding_matches_typescript():
    pytest.importorskip("onnxruntime")
    from memdot.embedder import LocalEmbedder

    embedder = LocalEmbedder()
    assert embedder.model_id == V["embedding"]["model"]
    ours = embedder.embed(V["embedding"]["texts"], "document")
    for mine, theirs in zip(ours, V["embedding"]["vectors"], strict=True):
        assert sum(a * b for a, b in zip(mine, theirs, strict=True)) > 0.9999


def test_registry_records_match():
    pytest.importorskip("eth_abi")
    from memdot.registry import (
        ACTION,
        NO_SALT,
        action_hash,
        encode_call,
        encode_record,
        owner_pair,
        signed_call,
        signing_message,
        uuid_to_bytes32,
    )

    registry = V["registry"]
    signed = registry["signed"]
    public_key, _ = owner_pair(bytes.fromhex(signed["seed"]))
    assert f"0x{public_key.hex()}" == signed["publicKey"]
    import sr25519

    message = bytes.fromhex(signed["message"][2:])
    # What Portaldot's precompile will check: the TypeScript signature verifies here, and vice versa.
    assert sr25519.verify(bytes.fromhex(signed["signature"][2:]), message, public_key)
    call = registry["call"]
    assert (
        encode_call(
            call["owner"],
            NO_SALT,
            ACTION.CreateSpace,
            encode_record.create_space(1),
            int(call["nonce"]),
            bytes([7] * 64),
        )
        == call["calldata"]
    )
    made = signed_call(
        owner_seed=bytes.fromhex(signed["seed"]),
        registry=registry["address"],
        salt=NO_SALT,
        action=ACTION.CreateSpace,
        data=encode_record.create_space(1),
    )
    assert made.startswith(call["calldata"][:10])

    assert uuid_to_bytes32(registry["uuid"]["id"]) == registry["uuid"]["bytes32"]
    for record in registry["records"]:
        assert action_hash(record["salt"], record["action"], record["data"]) == record["hash"]
    first = registry["records"][0]
    assert (
        signing_message(
            registry["address"], registry["owner"], int(registry["nonce"]), first["hash"]
        )
        == registry["signingMessage"]
    )
    grant = registry["records"][4]
    assert (
        encode_record.grant(
            uuid_to_bytes32("1c9e4f5a-7b2d-4e8f-8a62-3d4e5f6a7b8c"),
            f"0x{'00' * 32}",
            f"0x{'55' * 32}",
            1,
            1_800_000_000,
            f"0x{'66' * 32}",
        )
        == grant["data"]
    )
    assert (
        encode_record.add_objects([f"0x{'33' * 32}", f"0x{'44' * 32}"], [2, 3], [10, 2000])
        == registry["records"][3]["data"]
    )


def test_stopwords_are_the_same():
    assert sorted(STOPWORDS) == sorted(V["stopwords"])


@pytest.mark.skipif(
    not os.environ.get("MEMDOT_WRITE_VECTORS"),
    reason="Sealing is random, so this rewrites the file only when asked: CI asks.",
)
def test_writes_what_typescript_checks():
    """Seals with fixed keys, so `packages/sdk/test/python-vectors.test.ts` can open each blob."""
    space = V["space"]
    key = SpaceKey(space["epoch"], bytes.fromhex(space["key"]))
    recipient = crypto.space_recipient(key)
    entry = json.loads(V["sealed"]["entry"])
    entry["text"] = "Sealed by Python, café 東京."
    encrypted = crypto.encrypt_object(bytes(range(256)) * 300, 30_000)
    manifest = crypto.build_manifest(
        name="python.bin",
        mime="application/octet-stream",
        size=encrypted.size,
        padded_size=encrypted.padded_size,
        object_key=encrypted.object_key,
        chunks=[{"cid": cid_of(chunk), "bytes": len(chunk)} for chunk in encrypted.chunks],
        created_at="2026-11-02T10:00:00.000Z",
    )
    keyring = crypto.seal_space_keyring(
        space["id"],
        crypto.derive_space_keys(AMK, space["id"], space["epoch"]),
        [crypto.user_recipient(SEED)],
    )
    secret = crypto.recovery_secret(V["recoveryCode"])
    bundle = crypto.add_wrap(
        {"v": 1, "wraps": []}, AMK, kind="recovery", wrap_id="recovery", unlock_secret=secret
    )
    written = {
        "age": base64.b64encode(
            crypto.seal_to(b"hello from pyrage", [crypto.user_recipient(AMK)])
        ).decode(),
        "segment": base64.b64encode(
            crypto.seal_segment(
                [
                    crypto.SegmentEntry(id=entry["id"], kind="memory", data=encode_entry(entry)),
                    crypto.SegmentEntry(
                        id="f", kind="file", name="n.txt", mime="text/plain", data=b"tiny"
                    ),
                ],
                recipient,
            )
        ).decode(),
        "entryText": entry["text"],
        "manifest": base64.b64encode(crypto.seal_manifest(manifest, [recipient])).decode(),
        "objectChunks": [base64.b64encode(chunk).decode() for chunk in encrypted.chunks],
        "objectBytes": encrypted.size,
        "keyring": base64.b64encode(keyring).decode(),
        "keyBundle": crypto.dumps(bundle).decode(),
        "snapshot": base64.b64encode(_index().to_snapshot("2026-11-02T10:00:00.000Z")).decode(),
    }
    (HERE / "python-vectors.json").write_text(json.dumps(written, indent=2) + "\n", "utf8")
