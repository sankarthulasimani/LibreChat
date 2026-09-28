---
name: autonomous-workflow
description: Run a LibreChat change end to end with separate Design, Architect, Dev and Test agents, gated by .agents/workflow. Use when asked to deliver a feature or fix autonomously, to "run the workflow", or to evaluate the workflow on its benchmark scenarios.
---

# Autonomous delivery workflow (Devin)

The process, roles, contracts and guardrails live in `.agents/workflow/` (start with
`README.md` and `orchestrator.md`). This skill runs them with `run_workflow`: each stage is a
child Devin session, and `workflow.py` re-runs every gate locally with
`scripts/agent-workflow.mts`.

## Steps

1. **Load Node 24** (`.nvmrc`): `source ~/.nvm/nvm.sh && nvm use` and confirm
   `node scripts/agent-workflow.mts check-policy` passes on the checked-out commit. The
   children read the role docs from the base branch, so the workflow must be merged there.
2. **Pick the run id** `YYYYMMDD-<slug>` and write `.agents/runs/task.json`:
   ```json
   {"run_id": "20260928-tag-limit", "repo": "sankarthulasimani/LibreChat", "base": "main",
    "task": "<the full request, including any decisions the user already made>", "open_pr": true}
   ```
   Use `"base": "dev"` when targeting upstream `danny-avila/LibreChat`. Set `open_pr: false` for
   eval runs.
3. **Describe the run to the user before starting**: 4–5 stage agents plus up to
   `loop_limits` revision/fix rounds, all separate-VM child sessions billed to their ACUs.
4. **Run** `run_workflow` with `workflow_name: "librechat-autonomous-delivery"` and
   `script_path` set to the absolute path of `.devin/skills/autonomous-workflow/workflow.py`.
   Resume an interrupted run with the same `run_id` from the tool result.
5. **On escalation** (the run fails with `escalated to a human`), read
   `.agents/runs/<run-id>/state.json`, ask the user the blocking questions or show the
   unresolved findings, add their answers to `task.json > task`, and start a new run.
6. **On success**, report the PR URL, CI status and any non-blocking findings. Run
   `node scripts/agent-workflow.mts validate all --run .agents/runs/<run-id>` once more and
   include its result.

## Evaluating the workflow

After changing a role doc, contract, rubric or policy, run each scenario in
`.agents/workflow/evals/scenarios.json` with `open_pr: false`, then score it:
`node scripts/agent-workflow.mts eval-scenario <scenario-id> --run .agents/runs/<run-id>`.
Report the pass rate and every failing expectation.
