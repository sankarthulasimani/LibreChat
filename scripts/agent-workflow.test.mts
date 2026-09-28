import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';

import type {
  Json,
  Stage,
  Policy,
  ArchitecturePlan,
  DesignBrief,
  DevReport,
  TestReport,
} from './agent-workflow.mts';

import {
  checkDev,
  checkPlan,
  checkTest,
  loadRun,
  loadPolicy,
  checkPaths,
  checkPolicy,
  loadScenarios,
  checkReview,
  validateRun,
  globToRegExp,
  matchesAny,
  scanAddedLines,
  validateSchema,
  evaluateScenario,
  parseAddedLines,
} from './agent-workflow.mts';

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '../.agents/workflow/examples');
const policy: Policy = loadPolicy();
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(EXAMPLES, name), 'utf8'));
const clone = <T,>(value: T): T => structuredClone(value);
const rules = (issues: { rule: string; severity: string }[]) =>
  issues.filter((issue) => issue.severity === 'error').map((issue) => issue.rule);

const design = read<DesignBrief>('design-brief.json');
const plan = read<ArchitecturePlan>('architecture-plan.json');
const devReports = [
  read<DevReport>('dev-report.WP-1.json'),
  read<DevReport>('dev-report.WP-2.json'),
];
const testReport = read<TestReport>('test-report.json');

test('globs support globstar, braces and exclusions', () => {
  assert.ok(globToRegExp('**/*.test.{ts,mts}').test('scripts/a.test.mts'));
  assert.ok(globToRegExp('**/*.test.{ts,mts}').test('a.test.ts'));
  assert.ok(!globToRegExp('client/*').test('client/src/a.ts'));
  assert.ok(matchesAny('client/src/locales/de/translation.json', policy.protected_paths));
  assert.ok(!matchesAny('client/src/locales/en/translation.json', policy.protected_paths));
  assert.ok(!matchesAny('.env.example', policy.immutable_paths));
  assert.ok(matchesAny('api/.env', policy.immutable_paths));
});

test('the policy, contracts and worked example are internally consistent', () => {
  assert.deepEqual(checkPolicy(), []);
  const stages: Stage[] = ['design', 'architect', 'dev', 'test'];
  assert.ok(validateRun(EXAMPLES, stages, policy).every((result) => result.issues.length === 0));
});

test('schema validation reports missing, unknown and malformed fields', () => {
  const schema = JSON.parse(
    readFileSync(join(EXAMPLES, '../contracts/design-brief.schema.json'), 'utf8'),
  );
  const broken: { [key: string]: Json } = {
    ...JSON.parse(JSON.stringify(design)),
    risk: 'extreme',
    extra: true,
    acceptance_criteria: [{ id: 'X1' }],
  };
  delete broken.title;
  const messages = validateSchema(broken, schema);
  assert.ok(messages.some((message) => message.includes('$.title: is required')));
  assert.ok(messages.some((message) => message.includes('$.extra: is not allowed')));
  assert.ok(messages.some((message) => message.includes('"extreme" is not one of')));
  assert.ok(messages.some((message) => message.includes('does not match ^AC-[0-9]+$')));
});

test('a rubric verdict must follow from its scores', () => {
  const review = clone(plan.design_review);
  review.scores = review.scores.map((score) =>
    score.criterion === 'testable_criteria' ? { ...score, score: 0 } : score,
  );
  assert.deepEqual(rules(checkReview(review, 'design', policy)), ['rubric-verdict']);
  review.verdict = 'revise';
  assert.deepEqual(rules(checkReview(review, 'design', policy)), ['rubric-changes']);
  review.required_changes = ['Make AC-2 decidable'];
  assert.deepEqual(rules(checkReview(review, 'design', policy)), []);
  review.scores = review.scores.slice(1);
  assert.deepEqual(rules(checkReview(review, 'design', policy)), ['rubric-missing']);
});

test('a plan must trace every acceptance criterion to a package and a test', () => {
  const extended = clone(design);
  extended.acceptance_criteria.push({
    id: 'AC-5',
    kind: 'functional',
    given: 'g',
    when: 'w',
    then: 't',
  });
  assert.deepEqual(rules(checkPlan(plan, extended, policy)).sort(), [
    'ac-unassigned',
    'ac-untested',
  ]);
});

test('a plan cannot scope work into immutable paths or skip typechecks', () => {
  const unsafe = clone(plan);
  unsafe.work_packages[0].write_scope.push('.github/workflows/**');
  unsafe.work_packages[1].typecheck_workspaces = [];
  const found = rules(checkPlan(unsafe, design, policy));
  assert.ok(found.includes('scope-outside-dev'));
  assert.ok(found.includes('scope-immutable'));
  assert.ok(found.includes('typecheck-missing'));
});

test('dev path guardrails enforce stage scope, package scope and protected paths', () => {
  const [wp1] = plan.work_packages;
  assert.deepEqual(
    rules(checkPaths(['packages/data-provider/src/config.ts'], 'dev', policy, [wp1])),
    [],
  );
  assert.deepEqual(rules(checkPaths(['client/src/App.tsx'], 'dev', policy, [wp1])), [
    'package-scope',
  ]);
  assert.deepEqual(rules(checkPaths(['package-lock.json'], 'dev', policy, [wp1])), [
    'protected-path',
  ]);
  assert.deepEqual(rules(checkPaths(['.agents/workflow/policy.json'], 'dev', policy, [wp1])), [
    'immutable-path',
  ]);
  const granted = {
    ...wp1,
    protected_overrides: [{ path: 'package-lock.json', reason: 'new dependency' }],
  };
  assert.deepEqual(rules(checkPaths(['package-lock.json'], 'dev', policy, [granted])), []);
});

test('the test stage may only add or change tests', () => {
  assert.deepEqual(
    rules(checkPaths(['client/src/a/__tests__/a.spec.tsx', 'e2e/specs/x.spec.ts'], 'test', policy)),
    [],
  );
  assert.deepEqual(rules(checkPaths(['client/src/a/A.tsx'], 'test', policy)), ['stage-scope']);
});

test('a dev report must record passing typechecks and static checks', () => {
  const report = clone(devReports[1]);
  report.checks = report.checks.filter((check) => !check.command.includes('typecheck'));
  report.checks.push({ command: 'cd client && npx jest', result: 'fail', note: '' });
  assert.deepEqual(rules(checkDev(report, plan, policy)).sort(), [
    'check-failed',
    'typecheck-not-run',
  ]);
});

test('the test verdict must match the evidence and the tested head', () => {
  const failing = clone(testReport);
  failing.criteria_results[0].status = 'fail';
  assert.deepEqual(rules(checkTest(failing, design, plan, devReports, policy)), ['test-verdict']);
  failing.verdict = 'fail';
  assert.deepEqual(rules(checkTest(failing, design, plan, devReports, policy)), []);
  const stale = clone(testReport);
  stale.head_sha = devReports[0].head_sha;
  assert.deepEqual(rules(checkTest(stale, design, plan, devReports, policy)), ['head-mismatch']);
});

test('a plan that sends the design back is valid without planning details', () => {
  const review = clone(plan);
  review.design_review.verdict = 'revise';
  review.design_review.scores[0].score = 0;
  review.design_review.required_changes = ['state the empty-composer behavior'];
  review.work_packages = [];
  assert.deepEqual(rules(checkPlan(review, design, policy)), []);
  review.design_review.required_changes = [];
  assert.ok(rules(checkPlan(review, design, policy)).length > 0);
});

test('a check that did not run blocks a passing verdict', () => {
  const unrun = clone(testReport);
  unrun.checks[0].result = 'not_run';
  unrun.checks[0].note = 'no browser available';
  assert.deepEqual(rules(checkTest(unrun, design, plan, devReports, policy)), ['test-verdict']);
});

test('a test report on its own test commits is pinned through baseline_head_sha', () => {
  const extended = clone(testReport);
  extended.baseline_head_sha = extended.head_sha;
  extended.head_sha = 'abcdef1234567';
  assert.deepEqual(rules(checkTest(extended, design, plan, devReports, policy)), []);
  extended.baseline_head_sha = devReports[0].head_sha;
  assert.deepEqual(rules(checkTest(extended, design, plan, devReports, policy)), ['head-mismatch']);
});

test('diff rules flag added lines only in matching files', () => {
  const diff = [
    'diff --git a/client/src/A.tsx b/client/src/A.tsx',
    '+++ b/client/src/A.tsx',
    '@@ -1,0 +10,3 @@',
    '+const value: any = 1;',
    '+<div className="bg-red-500" />',
    '+it.only("x", () => {});',
    '+++ b/api/server/x.md',
    '@@ -0,0 +1 @@',
    '+const value: any = 1;',
  ].join('\n');
  const added = parseAddedLines(diff);
  assert.equal(added[1].line, 11);
  const issues = scanAddedLines(added, policy.diff_rules);
  assert.deepEqual(rules(issues).sort(), ['no-any', 'no-focused-tests', 'no-raw-palette']);
  assert.ok(issues.every((issue) => issue.message.startsWith('client/src/A.tsx:')));
});

test('validateRun blocks downstream stages on an invalid upstream artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-workflow-'));
  try {
    cpSync(EXAMPLES, dir, { recursive: true });
    const brief = { ...clone(design), blocking_questions: ['Which endpoints expose a limit?'] };
    writeFileSync(join(dir, 'design-brief.json'), JSON.stringify(brief));
    const [designResult] = validateRun(dir, ['design'], policy);
    assert.deepEqual(rules(designResult.issues), ['blocking-question']);
    writeFileSync(join(dir, 'design-brief.json'), '{"run_id": "x"}');
    const [architectResult] = validateRun(dir, ['architect'], policy);
    assert.deepEqual(rules(architectResult.issues), ['upstream-missing']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('benchmark scenarios score the worked example and detect misplacement', () => {
  const [counter] = loadScenarios().filter((scenario) => scenario.id === 'composer-counter');
  const run = loadRun(EXAMPLES, policy);
  assert.deepEqual(evaluateScenario(counter, run), []);
  const misplaced = clone(run);
  misplaced.plan?.modules.push({
    path: 'api/server/services/Counter.js',
    workspace: 'api',
    change: 'new',
    responsibility: 'count',
  });
  assert.deepEqual(rules(evaluateScenario(counter, misplaced)), [
    'scenario-placement',
    'scenario-placement',
  ]);
  const [ambiguous] = loadScenarios().filter((scenario) => scenario.id === 'ambiguous-request');
  assert.deepEqual(rules(evaluateScenario(ambiguous, run)), [
    'scenario-halt',
    'scenario-escalation',
  ]);
});
