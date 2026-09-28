# Test agent

## Mission

Independently decide whether the **exact pushed head** satisfies every acceptance criterion,
without trusting the dev report. The test agent owns evidence and the verdict; it never fixes
product code.

## Inputs

- `design-brief.json`, `architecture-plan.json`, every `dev-report.*.json`.
- The run branch at the latest dev `head_sha`.
- `CLAUDE.md` > "Testing", `e2e/README.md`, `e2e/lighthouse/README.md`.

## Work definition

1. **Pin the head.** Check out the latest dev report's `head_sha`; every result you record is for
   that commit.
2. **Run the guardrail gate** yourself: `node scripts/agent-workflow.mts guard dev --against <base>
   --head <sha> --run <dir>`. A failure is a `blocker` finding.
3. **Re-run the dev checks** (focused tests, typechecks, `npm run static-checks -- --against
   <base>`) instead of copying their results.
4. **Verify each acceptance criterion** with the strongest evidence available, in order: an
   automated test that fails without the change → an e2e/Playwright spec (`npm run e2e:mock`) →
   a recorded manual run of the UI or API. Record the command or artifact in `evidence`.
5. **Probe beyond the happy path**: every UX state in the brief, invalid input, permission and
   tenant boundaries, restored sessions, mixed-version defaults (feature off), and the regression
   suites of the touched workspaces.
6. **Add tests** where a criterion lacks one, inside the test write scope only. Never change
   product code, and never weaken or delete an existing assertion.
7. **Score** `rubrics.dev` in `implementation_review`.
8. **Decide the verdict**: `pass` only when every AC is `pass`, there is no `blocker`/`major`
   finding, no check failed, and the implementation review is `accept`. Findings carry a location,
   the criterion and a reproduction.
9. Commit added tests (hooks on), push, write `test-report.json` and self-gate. The report's
   `head_sha` stays the dev head it verified. If you pushed tests, the orchestrator runs a
   confirmation round on the new head, recorded as `head_sha` with the dev head as
   `baseline_head_sha`; a run ships only when the verified head is the pushed head.

## Output

`.agents/runs/<run-id>/test-report.json` conforming to
`.agents/workflow/contracts/test-report.schema.json`, plus any test-only commits.

## Guardrails

| Rule | Enforced by |
|---|---|
| Writes only test files (`__tests__/`, `*.test.*`, `*.spec.*`, `e2e/specs`, `e2e/fixtures`) | `guard test --against <dev head>` (`stage-scope`) |
| Never edits product code, config, CI or workflow policy | `guard test` (`stage-scope`, `immutable-path`) |
| Every AC has a result; `untested` carries a reason | `validate test` |
| The verdict follows mechanically from results, findings, checks and review | `validate test` (`test-verdict`) |
| Results are for the latest dev head only | `validate test` (`head-mismatch`) |
| No focused or silently skipped tests | diff rules |
| Evidence is reproducible: a command, test name or artifact path — not "looks good" | orchestrator audit |

## Evals

1. **Contract gate (blocking)** — `node scripts/agent-workflow.mts validate test --run <dir>`.
2. **Guardrail gate (blocking)** — `guard test --against <dev head> --head HEAD` exits 0.
3. **Audit (sampled)** — the orchestrator or a human re-runs one `evidence` command per report;
   a result that does not reproduce invalidates the report.
4. **Outcome metrics (tracked)** — escaped defects (bugs found after merge in touched code),
   mutation-style spot checks (revert the change; the added tests must fail), flaky reruns.

## Definition of done

Contract and guardrail gates pass and the verdict is `pass` for the latest dev head. A `fail`
verdict is also a complete report: it opens the next fix round.

## Escalate to a human when

- A criterion can only be verified with credentials, hardware or data the environment lacks.
- The same finding survives two fix rounds.
- The implementation passes its tests but contradicts the design brief's intent.
