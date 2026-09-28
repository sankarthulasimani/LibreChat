"""LibreChat autonomous delivery workflow: Design -> Architect -> Dev -> Test -> Ship.

Implements .agents/workflow/orchestrator.md. Each stage is a separate child Devin
session; this script moves artifacts between stages and re-runs every gate locally
with scripts/agent-workflow.mts, trusting only its own result.

Input: .agents/runs/task.json
  {"run_id": "20260928-tag-limit", "repo": "sankarthulasimani/LibreChat",
   "base": "main", "task": "<request>", "open_pr": true}
"""

import asyncio
import glob
import json
import os
import shutil
import subprocess
from pathlib import Path


def repo_root() -> Path:
    candidates = []
    if os.environ.get("LIBRECHAT_ROOT"):
        candidates.append(Path(os.environ["LIBRECHAT_ROOT"]))
    try:
        candidates.append(Path(__file__).resolve().parents[3])
    except NameError:
        pass
    candidates.append(Path.home() / "repos" / "LibreChat")
    for candidate in candidates:
        if (candidate / ".agents" / "workflow" / "policy.json").exists():
            return candidate
    raise RuntimeError("LibreChat checkout with .agents/workflow not found; set LIBRECHAT_ROOT")


ROOT = repo_root()
WORKFLOW_DIR = ROOT / ".agents" / "workflow"
POLICY = json.loads((WORKFLOW_DIR / "policy.json").read_text())
LIMITS = POLICY["loop_limits"]
TASK = json.loads((ROOT / ".agents" / "runs" / "task.json").read_text())
RUN_ID = TASK["run_id"]
REPO = TASK["repo"]
BASE = TASK.get("base", "main")
BRANCH = TASK.get("branch", f"devin/{RUN_ID}")
RUN_DIR = ROOT / ".agents" / "runs" / RUN_ID
RUN_REL = f".agents/runs/{RUN_ID}"

HANDOFF_SCHEMA = {
    "type": "object",
    "properties": {
        "artifact_json": {"type": "string", "description": "The stage artifact, serialized JSON, exactly as written to the run directory"},
        "branch": {"type": "string"},
        "head_sha": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["artifact_json", "summary"],
}
SHIP_SCHEMA = {
    "type": "object",
    "properties": {
        "pr_url": {"type": "string"},
        "head_sha": {"type": "string", "description": "The PR head commit CI ran on"},
        "ci_status": {"type": "string", "enum": ["passing", "failing", "pending"]},
        "failing_jobs": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["pr_url", "head_sha", "ci_status", "failing_jobs"],
}
TIME_LIMITS = {"design": 20, "architect": 30, "dev": 60, "test": 45, "ship": 20}


class Escalation(Exception):
    pass


# --------------------------------------------------------------------------- state


STATE = {"run_id": RUN_ID, "status": "running", "transitions": [], "gates": []}


def save_state(**updates):
    STATE.update(updates)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    (RUN_DIR / "state.json").write_text(json.dumps(STATE, indent=2, sort_keys=True))


def transition(to: str, reason: str):
    STATE["transitions"].append({"to": to, "reason": reason})
    save_state(state=to)
    log(f"-> {to}: {reason}")


def write_artifact(name: str, artifact: dict, round_tag: str):
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    target = RUN_DIR / name
    if target.exists():
        history = RUN_DIR / "history"
        history.mkdir(exist_ok=True)
        shutil.copy(target, history / f"{target.stem}.{round_tag}.json")
    target.write_text(json.dumps(artifact, indent=2, sort_keys=True))


# --------------------------------------------------------------------------- gates


def node_bin() -> str:
    found = shutil.which("node")
    if found:
        return found
    nvm = sorted(glob.glob(str(Path.home() / ".nvm/versions/node/v24*/bin/node")))
    if nvm:
        return nvm[-1]
    raise RuntimeError("node 24 is required to run the workflow gates")


def gate(*args: str) -> tuple[bool, str]:
    result = subprocess.run(
        [node_bin(), "scripts/agent-workflow.mts", *args],
        cwd=ROOT, capture_output=True, text=True,
    )
    output = (result.stdout + result.stderr).strip()
    STATE["gates"].append({"args": list(args), "passed": result.returncode == 0})
    save_state()
    return result.returncode == 0, output


def fetch_branch() -> None:
    subprocess.run(["git", "fetch", "origin", BASE], cwd=ROOT, capture_output=True, text=True, check=True)
    subprocess.run(["git", "fetch", "origin", BRANCH], cwd=ROOT, capture_output=True, text=True)


def branch_head() -> str:
    """The pushed head of the run branch, or the base head before the branch exists."""
    fetch_branch()
    for ref in (f"origin/{BRANCH}", f"origin/{BASE}"):
        result = subprocess.run(["git", "rev-parse", ref], cwd=ROOT, capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.strip()
    raise RuntimeError(f"neither origin/{BRANCH} nor origin/{BASE} resolves")


def archive_dev_reports(round_tag: str) -> None:
    history = RUN_DIR / "history"
    history.mkdir(parents=True, exist_ok=True)
    for report in RUN_DIR.glob("dev-report.*.json"):
        shutil.move(str(report), history / f"{report.stem}.{round_tag}.json")


def describe(stage: str) -> str:
    return subprocess.run(
        [node_bin(), "scripts/agent-workflow.mts", "describe", stage],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout


# --------------------------------------------------------------------------- prompts


def dumps(value) -> str:
    return json.dumps(value, indent=2, sort_keys=True)


def stage_prompt(stage: str, upstream: dict, instructions: str, feedback: list[str]) -> str:
    role = (WORKFLOW_DIR / "roles" / f"{stage}.md").read_text()
    parts = [
        f"You are the {stage.upper()} agent of the LibreChat autonomous delivery workflow, run `{RUN_ID}`.",
        f"Repository: {REPO}. Base branch: `{BASE}`. Run branch: `{BRANCH}`. Run directory: `{RUN_REL}` (git-ignored).",
        "Follow `.agents/workflow/roles/" + stage + ".md` exactly. Its current text:",
        "<role>\n" + role + "\n</role>",
        "Your contract, rubrics, write scope and diff rules (`node scripts/agent-workflow.mts describe " + stage + "`):",
        "<policy>\n" + describe(stage) + "\n</policy>",
        "<task>\n" + TASK["task"] + "\n</task>",
    ]
    for name, artifact in sorted(upstream.items()):
        parts.append(f"Before you start, write this upstream artifact to `{RUN_REL}/{name}` exactly:\n<artifact name=\"{name}\">\n{dumps(artifact)}\n</artifact>")
    if feedback:
        parts.append("This is a revision. Resolve every item below and nothing else:\n" + "\n".join(f"- {item}" for item in feedback))
    parts.append(instructions)
    parts.append(
        "Finish only when your stage's gates in the role doc exit 0. Never edit .agents/workflow/**, scripts/**, "
        ".github/**, .husky/**, .claude/**, .devin/**, AGENTS.md or CLAUDE.md; never skip git hooks; never force-push. "
        "If you hit a blocker only a human can resolve, record it (blocking_questions for Design, a blocker finding or "
        "a not_run check otherwise) instead of guessing. Return the artifact you wrote as `artifact_json` "
        "(serialized JSON), plus `branch`, `head_sha` (the pushed commit, when you pushed) and a one-paragraph `summary`."
    )
    return "\n\n".join(parts)


async def run_agent(stage: str, prompt: str, label: str) -> dict:
    result = await agent(
        prompt,
        phase=stage,
        label=label,
        schema=HANDOFF_SCHEMA,
        repos=[REPO],
        soft_time_limit_minutes=TIME_LIMITS[stage],
    )
    try:
        result["artifact"] = json.loads(result["artifact_json"])
    except json.JSONDecodeError as exc:
        result["artifact"] = None
        result["parse_error"] = str(exc)
    return result


async def produce(stage: str, name: str, upstream: dict, instructions: str, feedback: list[str],
                  label: str, round_tag: str, extra_gate=None) -> dict:
    """Runs one stage agent, writes its artifact and gates it; one retry with the gate output."""
    issues: list[str] = []
    for attempt in range(2):
        result = await run_agent(stage, stage_prompt(stage, upstream, instructions, feedback + issues), f"{label}#{attempt + 1}")
        artifact = result["artifact"]
        if artifact is None:
            issues = [f"artifact_json was not valid JSON: {result['parse_error']}"]
            continue
        write_artifact(name, artifact, f"{round_tag}.{attempt + 1}")
        if stage == "design" and artifact.get("blocking_questions"):
            return artifact
        if stage == "dev" and artifact.get("plan_review", {}).get("verdict") == "revise":
            return artifact
        ok, output = gate("validate", stage, "--run", str(RUN_DIR))
        if ok and extra_gate:
            ok, output = extra_gate(artifact)
        if ok:
            return artifact
        log(f"{label}: gate failed (attempt {attempt + 1})\n{output}")
        issues = [f"The orchestrator's gate failed on your artifact; fix these and re-run the gate:\n{output}"]
    raise Escalation(f"{label} failed its gates twice: {issues[-1]}")


# --------------------------------------------------------------------------- stages


def ordered_packages(plan: dict) -> list[dict]:
    remaining = {wp["id"]: wp for wp in plan["work_packages"]}
    ordered: list[dict] = []
    while remaining:
        ready = [wp for wp in remaining.values() if all(dep not in remaining for dep in wp["depends_on"])]
        if not ready:
            raise Escalation("work packages have a dependency cycle")
        for wp in sorted(ready, key=lambda item: int(item["id"].split("-")[1])):
            ordered.append(remaining.pop(wp["id"]))
    return ordered


async def design_and_plan() -> tuple[dict, dict]:
    design_feedback: list[str] = []
    for design_round in range(LIMITS["design_revisions"] + 1):
        transition("DESIGN", f"round {design_round}")
        design = await produce(
            "design", "design-brief.json", {},
            "Write only the design brief. Do not create branches or commits.",
            design_feedback, f"design-r{design_round}", f"r{design_round}",
        )
        if design.get("blocking_questions"):
            raise Escalation("design has blocking questions: " + "; ".join(design["blocking_questions"]))
        transition("ARCHITECT", f"design round {design_round} passed its gate")
        plan = await architect(design, [], design_round)
        review = plan["design_review"]
        if review["verdict"] == "accept":
            return design, plan
        design_feedback = review["required_changes"]
    raise Escalation(f"design not accepted after {LIMITS['design_revisions']} revisions: {design_feedback}")


async def architect(design: dict, feedback: list[str], round_index: int) -> dict:
    return await produce(
        "architect", "architecture-plan.json", {"design-brief.json": design},
        "Write only the architecture plan (and CONTEXT.md terms if needed). Score the design honestly in "
        "`design_review`. If you return `revise`, list the required changes and stop planning: the rest of the "
        "artifact only needs to be schema-valid.",
        feedback, f"architect-r{round_index}", f"r{round_index}",
    )


def dev_gate(wp_id: str, start_sha: str):
    """Package scope on this package's own commits; stage scope and diff rules on the whole branch."""
    def check(report: dict):
        fetch_branch()
        ok, package_output = gate("guard", "dev", "--against", start_sha, "--head", report["head_sha"],
                                  "--run", str(RUN_DIR), "--work-package", wp_id)
        branch_ok, branch_output = gate("guard", "dev", "--against", f"origin/{BASE}", "--head", report["head_sha"])
        return ok and branch_ok, package_output + "\n" + branch_output
    return check


async def develop(design: dict, plan: dict, wp: dict, fix_round: int, findings: list[dict], reports: dict) -> dict:
    upstream = {"design-brief.json": design, "architecture-plan.json": plan}
    upstream.update({f"dev-report.{key}.json": value for key, value in reports.items()})
    if fix_round:
        upstream["test-report.json"] = STATE["last_test_report"]
    instructions = (
        f"Implement work package {wp['id']} ({wp['title']}) only, round {fix_round}. "
        f"Check out `{BRANCH}` (create it from origin/{BASE} if it does not exist), commit with hooks enabled, "
        f"push, and write `{RUN_REL}/dev-report.{wp['id']}.json` with `round: {fix_round}`."
    )
    if findings:
        instructions += " Address exactly these test findings and list them in `findings_addressed`:\n" + dumps(findings)
    start_sha = branch_head()
    instructions += f" Start from `{start_sha}`; the orchestrator guards `{start_sha}..<your head>` against the package scope."
    return await produce(
        "dev", f"dev-report.{wp['id']}.json", upstream, instructions, [],
        f"dev-{wp['id']}-r{fix_round}", f"r{fix_round}", extra_gate=dev_gate(wp["id"], start_sha),
    )


async def implement_all(design: dict, plan: dict) -> tuple[dict, dict]:
    for plan_round in range(LIMITS["plan_revisions"] + 1):
        reports: dict = {}
        rejected = None
        for wp in ordered_packages(plan):
            transition("DEV", f"{wp['id']} round 0")
            report = await develop(design, plan, wp, 0, [], reports)
            if report["plan_review"]["verdict"] == "revise":
                rejected = report["plan_review"]["required_changes"]
                break
            reports[wp["id"]] = report
        if rejected is None:
            return plan, reports
        if plan_round == LIMITS["plan_revisions"]:
            break
        transition("ARCHITECT", "plan_review = revise")
        archive_dev_reports(f"plan-r{plan_round}")
        plan = await architect(design, rejected, plan_round + 1)
        if plan["design_review"]["verdict"] != "accept":
            raise Escalation("architect rejected the design during a plan revision")
    raise Escalation(f"plan not accepted after {LIMITS['plan_revisions']} revisions")


def test_gate(report: dict):
    fetch_branch()
    dev_head = report.get("baseline_head_sha") or report["head_sha"]
    return gate("guard", "test", "--against", dev_head, "--head", f"origin/{BRANCH}", "--run", str(RUN_DIR))


async def verify(design: dict, plan: dict, reports: dict) -> dict:
    previous = None
    confirm: str | None = None
    for fix_round in range(LIMITS["fix_rounds"] + 1):
        transition("TEST", f"round {fix_round}" + (" (confirming test commits)" if confirm else ""))
        upstream = {"design-brief.json": design, "architecture-plan.json": plan}
        upstream.update({f"dev-report.{key}.json": value for key, value in reports.items()})
        latest = max(reports.values(), key=lambda item: item["round"])
        if confirm:
            instructions = (
                f"Verify commit `{confirm}` of `{BRANCH}`: dev head `{latest['head_sha']}` plus the test-only commits "
                f"added by the previous Test round. Record `head_sha: {confirm}` and "
                f"`baseline_head_sha: {latest['head_sha']}`. Run every check, including the added tests. Do not push."
            )
        else:
            instructions = (
                f"Verify commit `{latest['head_sha']}` of `{BRANCH}`; record it as `head_sha`. Push only test files."
            )
        test = await produce(
            "test", "test-report.json", upstream, instructions,
            [], f"test-r{fix_round}", f"r{fix_round}", extra_gate=test_gate,
        )
        if test["verdict"] == "pass":
            pushed = branch_head()
            if pushed.startswith(test["head_sha"]) or test["head_sha"].startswith(pushed):
                return test
            if fix_round == LIMITS["fix_rounds"]:
                break
            confirm = pushed
            continue
        confirm = None
        signature = sorted(finding["description"] for finding in test["findings"])
        if signature == previous:
            raise Escalation("the same findings survived a fix round: " + "; ".join(signature))
        if fix_round == LIMITS["fix_rounds"]:
            break
        previous = signature
        save_state(last_test_report=test)
        failing = {item["id"] for item in test["criteria_results"] if item["status"] != "pass"}
        owner = {ac: wp["id"] for wp in plan["work_packages"] for ac in wp["acceptance_criteria"]}
        last_wp = ordered_packages(plan)[-1]["id"]
        by_wp: dict = {}
        for finding in test["findings"]:
            by_wp.setdefault(owner.get(finding.get("criterion") or "", last_wp), []).append(finding)
        for ac in failing:
            by_wp.setdefault(owner.get(ac, last_wp), [])
        for wp in ordered_packages(plan):
            if wp["id"] in by_wp:
                transition("DEV", f"fix round {fix_round + 1} for {wp['id']}")
                reports[wp["id"]] = await develop(design, plan, wp, fix_round + 1, by_wp[wp["id"]], reports)
    raise Escalation(f"test still failing after {LIMITS['fix_rounds']} fix rounds")


async def ship(design: dict, plan: dict, test: dict) -> dict:
    transition("SHIP", "test verdict pass")
    summary = {
        "acceptance_criteria": [criterion["id"] + ": " + criterion["then"] for criterion in design["acceptance_criteria"]],
        "work_packages": [wp["id"] + ": " + wp["title"] for wp in plan["work_packages"]],
        "test_head": test["head_sha"],
        "findings": test["findings"],
    }
    return await agent(
        f"In {REPO}, open a pull request from `{BRANCH}` into `{BASE}` for workflow run `{RUN_ID}`: {design['title']}.\n"
        "Use `.github/pull_request_template.md`. Describe the change from this summary, including a table of acceptance "
        "criteria and their verification, and list non-blocking findings under a 'Follow-ups' heading:\n"
        + dumps(summary)
        + "\nDo not change any code. Wait until every CI check on the PR head finishes (up to your time limit); "
        "report the PR URL, the PR `head_sha`, `ci_status` (passing, failing or pending) and `failing_jobs`.",
        phase="ship", label="ship", schema=SHIP_SCHEMA, repos=[REPO],
        soft_time_limit_minutes=TIME_LIMITS["ship"],
    )


async def main():
    await register_workflow({
        "name": "librechat-autonomous-delivery",
        "description": f"Design -> Architect -> Dev -> Test -> Ship for run {RUN_ID}",
        "product": "LibreChat",
        "phases": [
            {"title": "design", "detail": "Design brief with testable acceptance criteria"},
            {"title": "architect", "detail": "Architecture plan and work packages; reviews the design"},
            {"title": "dev", "detail": "Implement each work package on the run branch; reviews the plan"},
            {"title": "test", "detail": "Independent verification of the latest dev head"},
            {"title": "ship", "detail": "Open the PR and wait for CI"},
        ],
    })
    save_state(task=TASK, branch=BRANCH, base=BASE)
    try:
        design, plan = await design_and_plan()
        plan, reports = await implement_all(design, plan)
        test = await verify(design, plan, reports)
        if TASK.get("open_pr", True):
            shipped = await ship(design, plan, test)
            save_state(pr_url=shipped["pr_url"], ci_status=shipped["ci_status"], failing_jobs=shipped["failing_jobs"])
            if not test["head_sha"].startswith(shipped["head_sha"]) and not shipped["head_sha"].startswith(test["head_sha"]):
                raise Escalation(f"PR head {shipped['head_sha']} is not the verified head {test['head_sha']}")
            if shipped["ci_status"] == "failing":
                raise Escalation(f"CI failing on {shipped['pr_url']}: {', '.join(shipped['failing_jobs'])}")
            if shipped["ci_status"] == "pending":
                save_state(status="awaiting_ci")
                log(f"PR open, CI still pending: {shipped['pr_url']}")
            else:
                save_state(status="done")
                log(f"DONE: {shipped['pr_url']} (CI passing)")
        else:
            save_state(status="done")
            log(f"DONE without PR: branch {BRANCH} at {test['head_sha']}")
        ok, output = gate("validate", "all", "--run", str(RUN_DIR))
        log(output)
    except Escalation as reason:
        save_state(status="escalated", escalation=str(reason))
        log(f"ESCALATE: {reason}")
        raise RuntimeError(f"Run {RUN_ID} escalated to a human: {reason}") from None


asyncio.run(main())
