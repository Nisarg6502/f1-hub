#!/usr/bin/env python
"""Mine LangSmith thumbs-down runs into human-reviewable golden-set candidates.

    python scripts/curate_goldens.py --dry-run
    python scripts/curate_goldens.py --since 14 --limit 50
    python scripts/curate_goldens.py --since 7 --limit 20 --out candidates.txt

CP69's feedback loop (`POST /api/feedback`, see `backend/agent/main.py`) posts
a `user-score` feedback entry (`1` or `-1`) to LangSmith, keyed by the run id
that already rides out on every `done` SSE event (`tracing.run_id`). This
script queries LangSmith for the `-1` (thumbs-down) ones in a lookback window
and, for each, PRINTS a proposed `GoldenCase(...)` or `KnownHardCase(...)`
Python literal — in `agent/golden_set.py`'s own hand-authored style, credited
to the source run id — for a **human** to read, judge, and paste in
themselves. There is no `--yes`/`--apply` flag and no code path anywhere in
this file that opens `agent/golden_set.py` for writing: `golden_set.py`'s own
docstring says "the golden set must come from real traces, not from questions
we invented", and the batch plan is explicit that automatic promotion is
rejected — this script's *only* output channel is stdout (or `--out FILE`,
still just text for a human to read), by construction, not by a flag a future
run could accidentally omit.

**Venv decision (CP69 plan Task 3, Step 1):** this runs in the root
`scripts/` venv, matching its sibling `scripts/build_track_geometry.py`
(`pip install -r scripts/requirements.txt`), not the backend's
`requirements-agent.txt` — this script never imports FastAPI, deepagents, or
anything else backend-only, it only needs `langsmith` and stdlib, and running
alongside `build_track_geometry.py`'s existing convention (a light root venv
for "pull data, propose, print") keeps `scripts/` consistent for the next
person, rather than requiring the much heavier agent-service venv for a
one-file CLI.

**GoldenCase vs KnownHardCase — the heuristic, stated explicitly (a judgment
call the human reviewer can and should override):** LangSmith's own recorded
`chat` run only carries what `agent/tracing.py`'s `traced_run` actually
attaches — the question (`inputs["message"]`), and on `outputs`: `mode`,
`chars`, `evidence` (a *count*, not the ledger's contents), `tier`,
`verification`, `verification_violations`. The full answer text and the
evidence ledger's actual contents are NOT part of this run's own recorded
outputs (deepagents' child spans may carry them, but this script does not
walk the trace tree — that's future work, not assumed here). Given that
narrower surface: if `evidence_count == 0` — the model answered with no
grounding at all — that's the shape of the CP61/CP64 "parametric memory,
zero tool calls" failure `golden_set.py` already documents, so this script
proposes a `KnownHardCase` (a grounding-guard-relevant failure for the
verifier to catch). Otherwise (evidence was cited but the user still
thumbs-downed it) the more likely failure is the *router* sent the question
down the wrong tier/path, so this script proposes a `GoldenCase` (a router-
classification regression to re-check `router.classify` against).

Tests: `python -m unittest discover scripts/tests` (or
`python -m pytest scripts/tests/test_curate_goldens.py -v`) — covers only the
pure `format_candidate` function; the LangSmith-querying path is I/O and is
verified by running this script for real, per this repo's own convention for
CLI scripts (see scripts/README.md's `build_track_geometry.py` precedent).
"""

from __future__ import annotations

import argparse
import datetime
import sys


# --------------------------------------------------------------------------
# LangSmith fetch (I/O — exercised by a manual run, not a unit test)
# --------------------------------------------------------------------------


def fetch_thumbs_down_runs(client, since_days: int, limit: int) -> list[dict]:
    """Return up to `limit` thumbs-down (`user-score` == -1) runs from the
    last `since_days` days, each as a plain dict with only the fields this
    script can actually surface (see the module docstring for exactly what
    `traced_run` records).

    Two LangSmith calls, not one: `list_feedback` is the only way to filter
    by score, but a `Feedback` object only carries the run id, not the run's
    inputs/outputs — so each match is followed by a `read_run` to pull the
    question and the recorded output fields.
    """
    since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=since_days)

    runs: list[dict] = []
    feedback_iter = client.list_feedback(
        feedback_key=["user-score"],
        limit=max(limit * 4, limit),  # over-fetch: some may score +1 or predate `since`
    )
    for feedback in feedback_iter:
        if len(runs) >= limit:
            break
        if getattr(feedback, "score", None) != -1:
            continue
        created_at = getattr(feedback, "created_at", None)
        if created_at is not None and created_at < since:
            continue

        run_id = getattr(feedback, "run_id", None)
        if not run_id:
            continue
        try:
            run = client.read_run(run_id)
        except Exception as error:  # noqa: BLE001 - one bad lookup must not kill the batch
            print(f"skipping run {run_id}: could not read run ({error})", file=sys.stderr)
            continue

        inputs = getattr(run, "inputs", None) or {}
        outputs = getattr(run, "outputs", None) or {}
        runs.append(
            {
                "run_id": str(run_id),
                "question": inputs.get("message", ""),
                # Defensive/aspirational: `main.py`'s `tracing.end(run, {...})` never
                # records an "answer" key today (only mode, chars, evidence, tier,
                # verification, verification_violations), so this always returns ""
                # with the current `traced_run` outputs shape. Kept for a future
                # shape change rather than removed; the empty case is handled
                # correctly downstream either way.
                "answer": outputs.get("answer", ""),
                "tier": outputs.get("tier"),
                "verification": outputs.get("verification"),
                "verification_violations": outputs.get("verification_violations"),
                "evidence_count": outputs.get("evidence", 0) or 0,
                "comment": getattr(feedback, "comment", None),
            }
        )
    return runs


# --------------------------------------------------------------------------
# Pure candidate formatting (unit tested)
# --------------------------------------------------------------------------


def _py_str(value: str) -> str:
    """Render a Python string literal safely, whatever the source contains."""
    return repr(value)


def format_candidate(run_data: dict) -> str:
    """Turn one mined run into a human-readable, paste-ready proposed entry.

    Pure: takes a dict, returns a string. No file I/O, no LangSmith calls —
    this is the one function in this script that is unit tested (see
    scripts/tests/test_curate_goldens.py). See the module docstring for the
    GoldenCase-vs-KnownHardCase heuristic this implements.
    """
    run_id = run_data.get("run_id", "unknown-run-id")
    question = run_data.get("question", "") or ""
    answer = run_data.get("answer", "") or ""
    evidence_count = run_data.get("evidence_count", 0) or 0
    tier = run_data.get("tier")
    verification = run_data.get("verification")
    violations = run_data.get("verification_violations")
    comment = run_data.get("comment")

    lines: list[str] = []
    lines.append(f"# --- candidate from thumbs-down run {run_id} ---")
    lines.append(f"# question: {question!r}")
    if answer:
        lines.append(f"# answer:   {answer!r}")
    else:
        lines.append(
            "# answer:   <not captured in traced_run's outputs — traced_run only "
            "records chars/evidence-count/tier/verification, not the full text; "
            "pull it from the LangSmith UI for this run id if needed>"
        )
    lines.append(f"# tier={tier} verification={verification} violations={violations} "
                 f"evidence_count={evidence_count}")
    if comment:
        lines.append(f"# reviewer comment: {comment!r}")

    notes = (
        f"Mined from thumbs-down run {run_id} by scripts/curate_goldens.py. "
        "Human review required before this is trusted — verify the question, "
        "expected tier, and (for a KnownHardCase) the draft/evidence pair "
        "actually reproduce the failure before pasting into golden_set.py."
    )

    if evidence_count == 0:
        # No grounding at all -> the CP61/CP64-shaped "answered from parametric
        # memory, zero tool calls" failure. Propose a KnownHardCase so the
        # verifier's grounding guard has a fixture for it.
        draft = answer or (
            f"<PASTE THE ACTUAL DRAFT ANSWER TEXT HERE — not captured for run {run_id}>"
        )
        lines.append("candidate = KnownHardCase(")
        lines.append(f"    {_py_str(f'mined-{run_id}')},")
        lines.append(f"    source={_py_str(f'CP69 curate_goldens.py, thumbs-down run {run_id}')},")
        lines.append(f"    draft={_py_str(draft)},")
        lines.append("    evidence=(),  # empty ledger is the failure being documented")
        lines.append("    expected_pass=False,  # a human-reviewed judgment call, verify before trusting")
        lines.append(f"    notes={_py_str(notes)},")
        lines.append(")")
    else:
        lines.append("candidate = GoldenCase(")
        lines.append(f"    {_py_str(f'mined-{run_id}')},")
        lines.append("    0,  # TODO(human): fill in the real taxonomy_class (1-15, see golden_set.py)")
        lines.append(f"    {_py_str(question)},")
        lines.append(f"    expected_tier={tier if tier is not None else '0  # TODO(human): unknown tier'},")
        lines.append(f"    notes={_py_str(notes)},")
        lines.append(")")

    return "\n".join(lines)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--since", type=int, default=7, help="lookback window in days (default 7)"
    )
    parser.add_argument(
        "--limit", type=int, default=20, help="max thumbs-down runs to fetch (default 20)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the query plan and stop, no LangSmith call"
    )
    parser.add_argument(
        "--out",
        default=None,
        help="write proposed candidates to this file instead of stdout "
        "(still just text for a human to review — never golden_set.py)",
    )
    args = parser.parse_args(argv)

    if args.dry_run:
        print(
            f"would query LangSmith for user-score=-1 feedback in the last "
            f"{args.since} day(s), up to {args.limit} run(s), and print "
            f"proposed GoldenCase/KnownHardCase candidates for human review."
        )
        return 0

    try:
        import langsmith
    except Exception as error:  # noqa: BLE001
        print(f"langsmith is not installed or unavailable: {error}", file=sys.stderr)
        print("install it with: pip install -r scripts/requirements.txt", file=sys.stderr)
        return 1

    try:
        client = langsmith.Client()
    except Exception as error:  # noqa: BLE001
        print(f"could not create a LangSmith client (check LANGSMITH_API_KEY): {error}", file=sys.stderr)
        return 1

    try:
        runs = fetch_thumbs_down_runs(client, args.since, args.limit)
    except Exception as error:  # noqa: BLE001
        print(f"LangSmith query failed: {error}", file=sys.stderr)
        return 1

    blocks = [format_candidate(run) for run in runs]
    output = "\n\n".join(blocks) if blocks else "# no thumbs-down runs found in this window"
    summary = f"\n# --- {len(runs)} candidate(s) found, none written anywhere automatically ---"

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(output + "\n" + summary + "\n")
        print(f"wrote {len(runs)} candidate(s) to {args.out} — review before pasting into golden_set.py")
    else:
        print(output)
        print(summary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
