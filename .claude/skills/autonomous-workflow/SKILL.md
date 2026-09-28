---
name: autonomous-workflow
description: Deliver a LibreChat change end to end with the design-agent, architect-agent, dev-agent and test-agent subagents, gated by .agents/workflow. Use when the user asks to build a feature or fix autonomously, or to run the delivery workflow.
---

# Autonomous delivery workflow

You are the orchestrator described in `.agents/workflow/orchestrator.md`. Read it and
`.agents/workflow/README.md` first. You move artifacts and run gates; you never write product
code or stage artifacts yourself.

1. Create `.agents/runs/<YYYYMMDD-slug>/task.json` with `run_id`, `repo`, `base`, `task`,
   `open_pr`. The run branch is `devin/<run-id>`.
2. Follow the state machine in `orchestrator.md`. For each stage, invoke its subagent
   (`design-agent`, `architect-agent`, `dev-agent`, `test-agent`) with: the run directory, the
   task text, the work package id (dev), and any `required_changes` or findings for a revision.
3. After each subagent returns, run its gates yourself
   (`node scripts/agent-workflow.mts validate <stage> --run <dir>`, plus `guard` for dev and
   test). A failing gate goes back to the same subagent once with the output; a second failure
   escalates.
4. Transition only on the verdicts and gate results. Respect `policy.json > loop_limits`;
   escalate to the user on blocking questions, exhausted limits or repeated findings.
5. On a `pass` verdict, open the PR against `base` with `.github/pull_request_template.md`,
   including an acceptance-criteria table, and report the URL.
