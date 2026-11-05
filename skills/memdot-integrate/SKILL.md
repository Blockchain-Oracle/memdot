---
name: memdot-integrate
description: >
  Add MemDot long-term memory to an existing project: find where its model is called, choose Private
  or Assisted, write a failing test first, wire in the right adapter, and leave a branch plus notes
  for memdot-test-integration to check.
  TRIGGER when: the user says "add memdot to this project", "give this agent memory with memdot", or
  asks to wire MemDot into a repository.
  DO NOT TRIGGER when: the user only asks how an API works (use memdot), or the project is moving off
  Mem0 (use memdot-migrate-from-mem0).
license: Apache-2.0
metadata:
  author: Blockchain-Oracle
  version: 0.1.0
  category: ai-memory
---

# Integrate MemDot

You're adding memory to someone's working project. Change as little as you can, and don't call it done until a real round trip has passed.

## Rules for every run

1. **Work on a branch:** `memdot-integration`. Never commit to the default branch, and never push unless asked.
2. **A failing test first.** It has to fail for the right reason before you write the wiring.
3. **Real service, real keys, from the environment.** No mocks of MemDot in the proof. Never write a key or identity into source, a test, a fixture or `.memdot-integration/`.
4. **Scope comes from the app's own idea of a user.** Find what already identifies a person (a session user, a tenant, an account ID). If there isn't one, stop and ask. A hard-coded user ID merges everyone's memories.
5. **Memory failing must not fail the feature.** The model call still answers if MemDot is down. The adapters already do this. If you write your own wiring, use `AgentMemory`.
6. **Recalled memories are notes, not instructions.** Don't paste them into a prompt in a way that lets them read as commands.
7. **Tell the person what leaves their machine** when you recommend Assisted: the server reads that text. Ask before Assisted if the data looks sensitive (health, finance, legal, private messages).

## Steps

Keep notes in `.memdot-integration/plan.md` as you go, and add that folder to `.gitignore` only if the person prefers. It holds no secrets.

1. **Look.** Language, package manager, framework, where the model is called, how tests run, what identifies a user, and whether there's already a memory layer. Don't guess: open the files. Read [references/patterns.md](references/patterns.md) for what fits.
2. **Choose and say why.** Private or Assisted (see the `memdot` skill), recall automatically or through tools, and what gets saved. Write this down in the plan. Ask only if the data's sensitivity is unclear.
3. **Connect.** Check `memdot status`. If it isn't connected, have the person run `memdot login`, or `memdot login --print-env --label <project>` for a server. Add the variable names to `.env.example`, with no values. Create a namespace if one is needed: `memdot namespace create <project> --mode assisted --space <id>`.
4. **Write the failing test.** It should tell the app something unguessable, start over with nothing carried across, and expect the answer to hold it. A second user must not get it. Run it and see it fail.
5. **Wire it in.** The smallest change at the point where the model is already called.
6. **Make it pass.** Saving happens in the background, so poll in the test rather than sleeping a fixed time.
7. **Check what you touched.** The existing tests still pass, the lockfile changed only for what you added, and `git diff` holds no secrets.
8. **Leave notes** in `.memdot-integration/result.md`: the mode and why, the files changed, the namespace ID, the variables needed, how to run the test, and what you didn't do.
9. **Hand over.** Run the `memdot-test-integration` skill on the same branch, and report its scorecard.

## Stop and ask when

- Nothing in the app identifies a user.
- The app already has a memory layer, and it isn't clear whether MemDot replaces it or sits beside it.
- The data looks sensitive and the app only runs where a key can't be held.
- The account is over a quota, shown by `QUOTA_EXCEEDED` or `memdot usage`.
