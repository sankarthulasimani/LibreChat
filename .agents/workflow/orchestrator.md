# Orchestrator

The orchestrator runs the four stages as independent agents, moves artifacts between them,
enforces the gates, and decides every transition mechanically from the gate results and the
review verdicts. It never writes product code or artifacts itself.

## State machine

```
            ┌──────────── design_review = revise (≤ design_revisions) ────────────┐
            ▼                                                                     │
 INTAKE ─▶ DESIGN ──gate──▶ ARCHITECT ──gate──▶ DEV[WP-1..n] ──gate──▶ TEST ──pass──▶ SHIP
            │                  ▲                     │    ▲               │
            │                  └─ plan_review=revise ┘    └── fail (≤ fix_rounds) ┘
            │                     (≤ plan_revisions)
            └─ blocking question / limit reached / repeated finding ─────────▶ ESCALATE
```

| From | Condition | To |
|---|---|---|
| INTAKE | task recorded in `task.json` | DESIGN |
| DESIGN | contract gate fails (≤ 1 retry with the issues) | DESIGN |
| DESIGN | `blocking_questions` non-empty | ESCALATE |
| DESIGN | gate passes | ARCHITECT |
| ARCHITECT | `design_review.verdict = revise` | DESIGN with `required_changes` |
| ARCHITECT | gate passes | DEV (first work package in dependency order) |
| DEV | `plan_review.verdict = revise` | ARCHITECT with `required_changes` |
| DEV | contract or `guard dev` gate fails (≤ 1 retry with the issues) | DEV |
| DEV | gate passes, packages remain | DEV (next package) |
| DEV | gate passes, all packages done | TEST |
| TEST | `verdict = fail`, rounds remain, findings changed | DEV fix round for each affected package |
| TEST | `verdict = fail`, limit reached or same findings twice | ESCALATE |
| TEST | `verdict = pass` | SHIP |
| SHIP | PR opened against the base (or skipped when `open_pr` is false) | DONE |

Loop limits come from `policy.json > loop_limits`. Every retry is counted; nothing loops unbounded.

## Run directory

```
.agents/runs/<run-id>/          # git-ignored
  task.json                     # {run_id, repo, base, task, open_pr}
  design-brief.json
  architecture-plan.json
  dev-report.WP-<n>.json        # latest round per package
  test-report.json
  history/                      # every superseded artifact, suffixed with its round
  state.json                    # current state, transitions, gate results, escalation reason
```

Run ids are `YYYYMMDD-<slug>`. The run branch is `devin/<run-id>` and all dev and test commits
land on it.

## Gates

A gate is a command; it passes when it exits 0.

| Stage | Gate |
|---|---|
| design | `node scripts/agent-workflow.mts validate design --run <dir>` |
| architect | `node scripts/agent-workflow.mts validate architect --run <dir>` |
| dev | `validate dev --run <dir>` and `guard dev --against origin/<base> --head <head_sha> --run <dir> --work-package <WP>` |
| test | `validate test --run <dir>` and `guard test --against <dev head_sha> --head <test head> --run <dir>` |
| ship | CI green on the PR head (`static-checks`, workspace test and typecheck jobs) |

Agents run the same gates before returning (self-gating); the orchestrator re-runs them on the
returned artifact and trusts only its own result.

## Isolation

- Each stage is a separate agent with only its role doc, its policy slice (`describe <stage>`),
  the upstream artifacts and the task. Test never sees the dev agent's reasoning, only its report
  and commits.
- The reviewer of a stage is always the next stage (design → architect → dev → test), so every
  artifact is scored by a consumer that depends on its quality.
- Stages run sequentially; work packages run in dependency order on one branch, so there are no
  write collisions.

## Escalation

Escalating stops the run, writes the reason and the last artifacts to `state.json`, and reports
to the human: the blocking questions, the unresolved `required_changes`, or the repeated findings.
The human answers by editing `task.json` (e.g. adding decisions to the task) and resuming.

## Implementations

- **Devin** — `.devin/skills/autonomous-workflow/workflow.py`, run with `run_workflow`. Each stage
  is a child Devin session; the script runs the gates locally.
- **Claude Code** — `.claude/skills/autonomous-workflow/SKILL.md` drives the same loop with the
  subagents in `.claude/agents/`.
- **Manual / other agents** — follow this document; the gates are plain CLI commands.
