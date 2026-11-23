# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jenalsosmed-sudo/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jenalsosmed-sudo/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, 1st to 10th place $10 each in USDC on Solana ($100 total).

`mend` applies an edit that an AI model wrote to a tree of text files, reading all four
formats models write to one written contract (`SPEC.md`): a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. It finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory (the root of
  the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and
  no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; nothing is installed.

## How it applies an edit

Each edit names old lines O that are replaced by new lines N. O is found in the file at
the first of three matching tiers at which it occurs at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed from both;
- tier 2: every line equal once leading and trailing spaces and tabs are removed from
  both (new lines are re-indented to the file's indentation).

Unified hunks take the occurrence nearest the hunk's (possibly wrong) line number;
SEARCH/REPLACE blocks fail as `ambiguous` when the old lines occur more than once;
V4A chunks walk a cursor through the file, following `@@` anchors and
`*** End of File`; JSON edits are exact. A failed edit changes nothing, the edits
after it still run, and when any edit failed no file is written at all (exit 1).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move)
and `ok: <n> files`. Exit 2 reports `error: usage`, `error: no-patch`,
`error: format`, or `error: parse <N>`.

## Examples

Apply a unified diff, a SEARCH/REPLACE block, a V4A patch, or JSON edits:

    node main.ts fix.patch
    node main.ts --format=search-replace edit.txt
    cat patch.v4a | node main.ts --format=v4a -
    node main.ts --check --format=json edits.json

## The files

- `main.ts`: the CLI. `SPEC.md` is the whole contract it implements.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs
  `main.ts` on each one in a fresh directory, and posts what `main.ts` did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the practice
  score. This entry passes 100 of 100 practice checks (practice score 1000).
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
