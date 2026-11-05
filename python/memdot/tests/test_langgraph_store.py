"""The store's keys have to match TypeScript's, since the two read each other's items."""

import pytest

pytest.importorskip("langgraph")

from memdot.integrations.langgraph import _join, _matches_filter, _run_of, _split


def test_run_id_matches_typescript() -> None:
    namespace = ("memories", "acme/alex")
    assert _run_of(namespace, "deploys") == "store-208dc18e4a26c6631693e90a"
    assert _join(namespace) == "memories/acme%2Falex"


def test_labels_come_back_whole() -> None:
    for namespace in (("a", "b/c"), ("a%2Fb", "c"), ("100%", "d")):
        assert _split(_join(namespace)) == namespace


def test_filters_mean_what_langgraph_says() -> None:
    value = {"n": 3, "team": "pay", "tags": ["a", "b"]}
    assert _matches_filter(value, {"team": "pay"})
    assert not _matches_filter(value, {"team": {"$ne": "pay"}})
    assert _matches_filter(value, {"n": {"$gt": 2}})
    assert not _matches_filter(value, {"n": {"$lt": 3}})
    assert not _matches_filter(value, {"team": {"$gt": 1}})
    assert _matches_filter(value, {"tags": ["a", "b"]})
