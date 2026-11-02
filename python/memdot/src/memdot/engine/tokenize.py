"""The terms a text is searched under. The same word lands on the same term in every language."""

from __future__ import annotations

import re
import unicodedata

#: Words too common to help a keyword search. Short on purpose: recall matters more than size.
STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "do",
        "does",
        "did",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "his",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "me",
        "my",
        "no",
        "not",
        "of",
        "on",
        "or",
        "our",
        "she",
        "so",
        "that",
        "the",
        "their",
        "them",
        "they",
        "this",
        "to",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
    ]
)

#: What JavaScript's `\\s` and `trim` count as space. Python's `\\s` differs at the edges.
JS_SPACE = re.escape(
    "".join(
        map(
            chr,
            (
                *range(0x09, 0x0E),
                0x20,
                0xA0,
                0x1680,
                *range(0x2000, 0x200B),
                0x2028,
                0x2029,
                0x202F,
                0x205F,
                0x3000,
                0xFEFF,
            ),
        )
    )
)

# `[^\W_]` is a letter or a number; `re` has no \p{L}.
_WORD = re.compile(r"[^\W_][\w'\-]*")
_TRAILING = re.compile(r"['_\-]+$")
_ASCII_LETTERS = re.compile(r"^[a-z]+$")
_NOT_PLURAL = re.compile(r"(ss|us|is)$")
_VOWEL = re.compile(r"[aeiouy]")
_DOUBLED = re.compile(r"([b-df-hj-np-tv-z])\1$")
_KEEPS_DOUBLE = re.compile(r"(ll|ss|zz)$")
_MAX_TERM_CHARS = 64


def _stem(word: str) -> str:
    """A light English stemmer, so "meetings" finds "meeting"."""
    if len(word) <= 3 or not _ASCII_LETTERS.match(word):
        return word
    if word.endswith("ies"):
        return f"{word[:-3]}y"
    if word.endswith("sses"):
        return word[:-2]
    if word.endswith("s") and not _NOT_PLURAL.search(word):
        return _stem(word[:-1])
    for suffix in ("ing", "ed"):
        if not word.endswith(suffix):
            continue
        base = word[: -len(suffix)]
        if len(base) < 3 or not _VOWEL.search(base):
            return word
        if _DOUBLED.search(base) and not _KEEPS_DOUBLE.search(base):
            return base[:-1]
        return base
    return word


def tokenize(text: str) -> list[str]:
    terms: list[str] = []
    for word in _WORD.findall(unicodedata.normalize("NFKC", text).lower()):
        cleaned = _TRAILING.sub("", word)[:_MAX_TERM_CHARS]
        if cleaned and cleaned not in STOPWORDS:
            terms.append(_stem(cleaned))
    return terms


def term_frequencies(text: str) -> dict[str, int]:
    """Each distinct term with how many times it appears."""
    counts: dict[str, int] = {}
    for term in tokenize(text):
        counts[term] = counts.get(term, 0) + 1
    return counts
