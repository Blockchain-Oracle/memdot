#!/usr/bin/env python3
"""Three agents that have never met share one memory, and each keeps track of who said what.

A researcher finds facts, a critic reads them and adds what's missing, and a writer who was told
nothing reads both and writes a brief. They only talk through MemDot: each starts with its own client,
as it would in its own process or on its own machine.
"""

from __future__ import annotations

import os
import sys
import time
import uuid

import httpx

from memdot import MemDot

MODEL = os.environ.get("EXAMPLE_MODEL", "gemini-2.5-flash")
MODEL_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
MODEL_RETRIES = 5
MODEL_RETRY_SECONDS = 20
RETRY_STATUSES = {429, 500, 503}
NAMESPACE = os.environ.get("MEMDOT_NAMESPACE") or None


def ask(prompt: str) -> str:
    """Any model works here. This one has a free tier, which limits requests by the minute."""
    key = os.environ["GEMINI_API_KEY"]
    for attempt in range(1, MODEL_RETRIES + 1):
        response = httpx.post(
            MODEL_URL,
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60,
        )
        if response.status_code in RETRY_STATUSES and attempt < MODEL_RETRIES:
            print(f"  (the model is busy; trying again in {MODEL_RETRY_SECONDS} s)")
            time.sleep(MODEL_RETRY_SECONDS)
            continue
        response.raise_for_status()
        parts = response.json()["candidates"][0]["content"]["parts"]
        return "".join(part.get("text", "") for part in parts).strip()
    raise RuntimeError("unreachable")


def lines_of(text: str) -> list[str]:
    return [line.lstrip("-*• ").strip() for line in text.splitlines() if line.strip()]


class Agent:
    """One member of the team: its own client, its own name, and the project they all share."""

    def __init__(self, name: str, project: str) -> None:
        self.name = name
        self.project = project
        self.memory = MemDot.from_credentials()

    def note(self, text: str) -> None:
        """Written down exactly as it is, signed, under the shared project."""
        self.memory.add(
            text,
            agent_id=self.name,
            run_id=self.project,
            namespace_id=NAMESPACE,
            infer=False,
        )

    def remember_alone(self, text: str) -> None:
        """Under this agent only, with no project, so the others' project searches don't find it."""
        self.memory.add(text, agent_id=self.name, namespace_id=NAMESPACE, infer=False)

    def read_project(self, query: str) -> list[tuple[str, str]]:
        """Everyone's notes on this project, and who wrote each one."""
        hits = self.memory.search(query, run_id=self.project, namespace_id=NAMESPACE, top_k=20)
        return [(hit.agent_id or "unknown", hit.memory) for hit in hits]


def wait_for_notes(agent: Agent, query: str, want: int) -> list[tuple[str, str]]:
    deadline = time.time() + 60
    notes = agent.read_project(query)
    while len(notes) < want and time.time() < deadline:
        time.sleep(2)
        notes = agent.read_project(query)
    return notes


def main() -> int:
    topic = " ".join(sys.argv[1:]) or "opening a small neighbourhood bakery"
    run = uuid.uuid4().hex[:8]
    project = f"brief-{run}"
    researcher = Agent(f"researcher-{run}", project)
    critic = Agent(f"critic-{run}", project)
    writer = Agent(f"writer-{run}", project)
    print(f"Project {project}: {topic}\n")

    try:
        print(f"{researcher.name} is finding facts…")
        facts = lines_of(
            ask(f"Give exactly 3 short, practical facts about {topic}. One per line, no numbering.")
        )[:3]
        for fact in facts:
            researcher.note(fact)
            print(f"  noted: {fact}")

        print(f"\n{critic.name} reads what's there, knowing nothing else…")
        seen = wait_for_notes(critic, topic, len(facts))
        assert seen, "the critic found nothing"
        listed = "\n".join(f"- {text}" for _, text in seen)
        risk = lines_of(
            ask(f"These notes are about {topic}:\n{listed}\n\nIn one short sentence, what risk did they miss?")
        )[0]
        critic.note(risk)
        print(f"  saw {len(seen)} notes, and added: {risk}")

        print(f"\n{writer.name} gets one question and whatever's in memory…")
        everything = wait_for_notes(writer, topic, len(facts) + 1)
        authors = sorted({author for author, _ in everything})
        print(f"  found {len(everything)} notes, from: {', '.join(authors)}")
        credited = "\n".join(f"- ({author}) {text}" for author, text in everything)
        brief = ask(f"Using only these notes, write a two-sentence brief on {topic}:\n{credited}")
        print(f"\nThe brief:\n{brief}\n")

        print("Each agent can also keep something to itself.")
        writer.remember_alone(f"My reader for {project} prefers short sentences.")
        shared = writer.read_project("who prefers short sentences?")
        mine = writer.memory.search(
            "who prefers short sentences?",
            agent_id=writer.name,
            namespace_id=NAMESPACE,
            top_k=3,
        )
        leaked = any("prefers short sentences" in text for _, text in shared)
        print(f"  in the project's memory: {'yes' if leaked else 'no'}")
        print(f"  in the writer's own: {'yes' if mine else 'no'}")

        if len(authors) < 2 or leaked or not mine:
            print("\nThat isn't what should have happened.")
            return 1
        print("\nThree agents, one memory, and everyone's words signed.")
        return 0
    finally:
        cleaner = MemDot.from_credentials()
        cleaner.delete_all(run_id=project, namespace_id=NAMESPACE)
        cleaner.delete_all(agent_id=writer.name, namespace_id=NAMESPACE)


if __name__ == "__main__":
    sys.exit(main())
