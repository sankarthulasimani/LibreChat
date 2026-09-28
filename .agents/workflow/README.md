# Autonomous delivery workflow

A four-stage agent workflow for LibreChat — **Design → Architect → Dev → Test** — where every
stage has a written work definition, a machine-checked output contract, guardrails enforced on
the git diff, and a rubric scored by the next stage.

| Path | What it is |
|---|---|
| `orchestrator.md` | State machine, loop limits, gates, escalation |
| `roles/<stage>.md` | Mission, inputs, work definition, guardrails, evals, definition of done |
| `contracts/*.schema.json` | JSON Schema for each stage's handoff artifact |
| `policy.json` | Single source of truth: write scopes, immutable/protected paths, diff rules, rubrics, loop limits, workspace commands |
| `evals/scenarios.json` | Benchmark tasks with expected outcomes, for evaluating the workflow itself |
| `examples/` | A complete, valid run (a composer character counter) used as a fixture |
| `../../scripts/agent-workflow.mts` | The gate: `describe`, `validate`, `guard`, `eval-scenario`, `check-policy` |

## Stages at a glance

| Stage | Produces | Writes | Reviewed by | Key gates |
|---|---|---|---|---|
| Design | `design-brief.json`: problem, goals/non-goals, `AC-n` Given/When/Then, UX states, config levers | `.agents/runs/**` | Architect (`rubrics.design`) | schema, unique ACs, no blocking questions |
| Architect | `architecture-plan.json`: placement, interfaces, work packages with scopes and tests, risks, rollback | `.agents/runs/**`, `CONTEXT.md` | Dev (`rubrics.architect`) | every AC owned and tested, scopes inside Dev scope, typechecks listed, levers in `configSchema` |
| Dev | commits + `dev-report.WP-n.json` | package `write_scope` only | Test (`rubrics.dev`) | `guard dev` on the diff, typechecks and `static-checks` recorded passing |
| Test | test-only commits + `test-report.json` | test files only | orchestrator (mechanical) | verdict consistent with evidence, head pinned to latest dev head |

## Guardrails (from `policy.json`)

- **Immutable paths** — no stage may change the workflow policy, CI, hooks, agent docs, `scripts/`,
  ESLint config or env files. Changing the rules is a human PR.
- **Protected paths** — manifests, lockfiles, `turbo.json`, deploy files and non-English locales
  need an explicit `protected_overrides` entry (with a reason) in the architect's work package.
- **Stage and package scopes** — every changed file must match the stage scope and, for Dev, its
  work package's `write_scope`.
- **Diff rules** — added lines are scanned for secrets, `any`, `as unknown as`, `@ts-ignore`,
  focused tests, raw Tailwind palette colors and Mongoose outside `data-schemas` (errors), plus
  new control flow in `/api`, Recoil atoms, dynamic imports, console logging, lint suppressions
  and skipped tests (warnings the Test agent must judge).
- **Loop limits** — 2 design revisions, 2 plan revisions, 3 fix rounds, ≤ 6 work packages of
  ≤ 30 files; a repeated finding escalates immediately.

## Evals

1. **Per-artifact gates** — `validate` and `guard` are deterministic and blocking.
2. **Per-stage rubrics** — the consumer scores 6 criteria 0–2; any critical criterion at 0, or a
   normalized score below the threshold, forces `revise` with `required_changes`. The gate
   rejects a verdict that does not follow from its scores.
3. **Workflow evals** — run the workflow on each scenario in `evals/scenarios.json` and score it
   with `eval-scenario`. Scenarios check placement (e.g. nothing new in `/api`), criteria
   coverage (compatibility, i18n, a11y), fix-round budget, final verdict, and that ambiguous or
   guardrail-bait requests halt at Design instead of shipping.
4. **Tracked metrics** — first-round acceptance per stage, fix rounds per run, guard warnings,
   CI failures after a green local report, escaped defects.

## Usage

```bash
# Inspect a stage's contract, rubric, scopes and rules
node scripts/agent-workflow.mts describe dev

# Gate artifacts in a run directory
node scripts/agent-workflow.mts validate all --run .agents/runs/<run-id>

# Gate a diff
node scripts/agent-workflow.mts guard dev --against origin/main --run .agents/runs/<run-id> --work-package WP-1
node scripts/agent-workflow.mts guard test --against <dev head> --head HEAD

# Score a finished run against a benchmark scenario
node scripts/agent-workflow.mts eval-scenario bookmarks-empty-state --run .agents/runs/<run-id>

# Self-test the workflow after editing policy, contracts or the script
npm run test:agent-workflow
```

Start a run with Devin via the `autonomous-workflow` skill (`.devin/skills/autonomous-workflow`),
or with Claude Code via `/autonomous-workflow`.

## Ticket intake (Azure DevOps)

A scheduled Devin automation turns work items into runs, so a ticket moved to `AI_Ready` ends
as a PR without anyone starting a session:

```text
AI_Ready --claim--> AI_In_Progress --Design/Architect/Dev/Test/Ship--> AI_Review  (PR linked + comment)
                                    \--escalation or failure-----------> AI_Blocked (reason + questions)
```

- `tickets.json` maps the tracker to this repo. `trigger: "tag"` (default) uses the four markers
  as work item tags, exactly one at a time, and leaves the state alone unless `state_moves` names a
  state per work item type (e.g. `{"Bug": {"in_progress": "Dev-In-Progress"}}`).
  `trigger: "state"` uses them as `System.State` values, which must exist in the process.
  It also lists work item types, an optional area path, the rich-text fields and a tag added on
  claim. `ADO_ORG_URL`, `ADO_PROJECT` and `ADO_PAT` (Work Items read & write) come from Devin
  secrets; either URL secret may be any Azure DevOps URL of the project.
- `node scripts/ticket-intake.mts next` picks the highest-priority, oldest ready item, claims it
  with a rev-guarded patch (a second poller loses the race and skips it), and writes
  `.agents/runs/task.json` with the title, description, acceptance criteria and ticket link.
  `--dry-run` shows the next item without claiming it.
- `workflow.py` reports back through `ticket-intake.mts report`: `review` with the PR link and
  verified criteria, or `blocked` with the escalation reason (blocking design questions,
  exhausted loops, failing CI). Answer on the ticket and set it back to `AI_Ready` to rerun.

## Changing the workflow

Edit `policy.json`, a contract or a role doc in a normal PR, update `examples/` if a contract
changed, and run `npm run test:agent-workflow`. The `Agent Workflow` CI job runs the same checks.
