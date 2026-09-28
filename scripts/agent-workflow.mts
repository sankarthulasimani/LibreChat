#!/usr/bin/env node
/**
 * Deterministic gates for the autonomous design → architect → dev → test
 * workflow described in .agents/workflow/README.md.
 *
 * Every stage hands off a JSON artifact. `validate` checks an artifact against
 * its contract (.agents/workflow/contracts) and against the artifacts it
 * depends on: acceptance-criteria traceability, rubric/verdict consistency,
 * write-scope compliance, and head-SHA agreement. `guard` checks a git diff
 * against the stage's write scope, the immutable and protected paths, and the
 * added-line rules in .agents/workflow/policy.json.
 *
 * Runs on Node 24+ via native type-stripping:
 *
 *   node scripts/agent-workflow.mts describe dev
 *   node scripts/agent-workflow.mts validate design --run .agents/runs/<id>
 *   node scripts/agent-workflow.mts validate all --run .agents/runs/<id>
 *   node scripts/agent-workflow.mts guard dev --against origin/dev --run .agents/runs/<id>
 *   node scripts/agent-workflow.mts guard test --against <dev head sha> --head HEAD
 *   node scripts/agent-workflow.mts check-policy
 *   node scripts/agent-workflow.mts eval-scenario <scenario-id> --run .agents/runs/<id>
 *
 * Exits 1 when any error-severity issue is found; warnings are printed only.
 */

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const STAGES: Stage[] = ['design', 'architect', 'dev', 'test'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, '.agents/workflow');

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Stage = 'design' | 'architect' | 'dev' | 'test';
export type Severity = 'error' | 'warn';

export interface Issue {
  severity: Severity;
  rule: string;
  message: string;
}

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
}

interface RubricCriterion {
  id: string;
  critical: boolean;
  description: string;
}

interface Rubric {
  threshold: number;
  criteria: RubricCriterion[];
}

interface StagePolicy {
  artifact: string;
  contract: string;
  reviewed_by: string;
  write_scope: string[];
}

interface DiffRule {
  id: string;
  severity: Severity;
  files: string[];
  pattern: string;
  message: string;
}

interface WorkspacePolicy {
  path: string;
  typecheck: string | null;
  test: string;
}

export interface Policy {
  version: number;
  loop_limits: {
    design_revisions: number;
    plan_revisions: number;
    fix_rounds: number;
    max_work_packages: number;
    max_files_per_work_package: number;
  };
  stages: Record<Stage, StagePolicy>;
  immutable_paths: string[];
  protected_paths: string[];
  diff_rules: DiffRule[];
  rubrics: Record<'design' | 'architect' | 'dev', Rubric>;
  workspaces: Record<string, WorkspacePolicy>;
}

interface Review {
  verdict: 'accept' | 'revise';
  scores: { criterion: string; score: number; note: string }[];
  required_changes: string[];
}

interface AcceptanceCriterion {
  id: string;
  kind: string;
  given: string;
  when: string;
  then: string;
}

export interface DesignBrief {
  run_id: string;
  surfaces: string[];
  acceptance_criteria: AcceptanceCriterion[];
  ux_states: Record<string, string>;
  config_levers: { name: string; purpose: string; default: string }[];
  blocking_questions: string[];
}

interface WorkPackage {
  id: string;
  title: string;
  depends_on: string[];
  write_scope: string[];
  protected_overrides: { path: string; reason: string }[];
  acceptance_criteria: string[];
  tests: { path: string; kind: string; covers: string[] }[];
  typecheck_workspaces: string[];
}

export interface ArchitecturePlan {
  run_id: string;
  design_review: Review;
  modules: { path: string; workspace: string; change: 'new' | 'modify'; responsibility: string }[];
  config_fields: { field: string; schema_location: string; default: string }[];
  data_changes: { migration_required: boolean; stored_data_compatibility: string };
  work_packages: WorkPackage[];
  risks: { risk: string; mitigation: string }[];
}

interface Check {
  command: string;
  result: 'pass' | 'fail' | 'not_run';
  note: string;
}

export interface DevReport {
  run_id: string;
  work_package: string;
  round: number;
  plan_review: Review;
  head_sha: string;
  files_changed: string[];
  checks: Check[];
  criteria_status: {
    id: string;
    status: 'implemented' | 'partial' | 'not_started';
    evidence: string;
  }[];
}

export interface TestReport {
  run_id: string;
  head_sha: string;
  implementation_review: Review;
  verdict: 'pass' | 'fail';
  criteria_results: {
    id: string;
    status: 'pass' | 'fail' | 'untested';
    evidence: string;
    note: string;
  }[];
  checks: Check[];
  findings: { severity: 'blocker' | 'major' | 'minor'; criterion: string; location: string }[];
}

export interface RunArtifacts {
  design?: DesignBrief;
  plan?: ArchitecturePlan;
  dev: DevReport[];
  test?: TestReport;
}

const error = (rule: string, message: string): Issue => ({ severity: 'error', rule, message });
const warn = (rule: string, message: string): Issue => ({ severity: 'warn', rule, message });

/* ------------------------------------------------------------------------ */
/* Globs                                                                     */
/* ------------------------------------------------------------------------ */

const GLOB_CACHE = new Map<string, RegExp>();

/** Supports `**`, `**\/`, `*`, `?` and `{a,b}`; everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_CACHE.get(glob);
  if (cached) return cached;
  let source = '';
  let braceDepth = 0;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }
    if (glob.startsWith('**', index)) {
      source += '.*';
      index++;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '{') {
      braceDepth++;
      source += '(?:';
      continue;
    }
    if (char === '}' && braceDepth > 0) {
      braceDepth--;
      source += ')';
      continue;
    }
    if (char === ',' && braceDepth > 0) {
      source += '|';
      continue;
    }
    source += /[a-zA-Z0-9/_-]/.test(char) ? char : `\\${char}`;
  }
  const regex = new RegExp(`^${source}$`);
  GLOB_CACHE.set(glob, regex);
  return regex;
}

/** A path matches when some include matches and no `!` exclusion does. */
export function matchesAny(file: string, patterns: readonly string[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(file)) return false;
      continue;
    }
    included = included || globToRegExp(pattern).test(file);
  }
  return included;
}

/** The literal directory prefix of a glob, used to test a scope against another scope. */
function globProbe(glob: string): string {
  const wildcard = glob.search(/[*?{]/);
  if (wildcard === -1) return glob;
  return `${glob.slice(0, wildcard)}__probe__`;
}

/* ------------------------------------------------------------------------ */
/* JSON Schema subset                                                        */
/* ------------------------------------------------------------------------ */

function jsonType(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

/** Validates the keywords the workflow contracts use; returns one message per violation. */
export function validateSchema(value: Json, schema: JsonSchema, at = '$'): string[] {
  const actual = jsonType(value);
  if (schema.type && !typeMatches(schema.type, actual)) {
    return [`${at}: expected ${schema.type}, got ${actual}`];
  }
  if (typeof value === 'string') {
    const problems: string[] = [];
    if (schema.enum && !schema.enum.includes(value)) {
      problems.push(`${at}: "${value}" is not one of ${schema.enum.join(', ')}`);
    }
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
      problems.push(`${at}: must not be empty`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${at}: "${value}" does not match ${schema.pattern}`);
    }
    return problems;
  }
  if (typeof value === 'number') {
    const problems: string[] = [];
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${at}: ${value} < ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${at}: ${value} > ${schema.maximum}`);
    }
    return problems;
  }
  if (Array.isArray(value)) {
    const problems: string[] = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${at}: needs at least ${schema.minItems} item(s)`);
    }
    if (!schema.items) return problems;
    const itemSchema = schema.items;
    return problems.concat(
      value.flatMap((item, i) => validateSchema(item, itemSchema, `${at}[${i}]`)),
    );
  }
  if (value === null || typeof value !== 'object') return [];
  const properties = schema.properties ?? {};
  const missing = (schema.required ?? [])
    .filter((key) => !(key in value))
    .map((key) => `${at}.${key}: is required`);
  const unknown =
    schema.additionalProperties === false
      ? Object.keys(value)
          .filter((key) => !(key in properties))
          .map((key) => `${at}.${key}: is not allowed`)
      : [];
  const nested = Object.entries(value)
    .filter(([key]) => key in properties)
    .flatMap(([key, child]) => validateSchema(child, properties[key], `${at}.${key}`));
  return [...missing, ...unknown, ...nested];
}

/* ------------------------------------------------------------------------ */
/* Semantic gates                                                            */
/* ------------------------------------------------------------------------ */

/** Checks that a downstream stage scored every rubric criterion and that its verdict follows. */
export function checkReview(
  review: Review,
  reviewed: keyof Policy['rubrics'],
  policy: Policy,
): Issue[] {
  const rubric = policy.rubrics[reviewed];
  const expectedIds = new Set(rubric.criteria.map((criterion) => criterion.id));
  const scored = new Map(review.scores.map((score) => [score.criterion, score.score]));
  const issues: Issue[] = [];
  for (const id of expectedIds) {
    if (!scored.has(id))
      issues.push(error('rubric-missing', `${reviewed} rubric criterion "${id}" was not scored`));
  }
  for (const id of scored.keys()) {
    if (!expectedIds.has(id))
      issues.push(error('rubric-unknown', `"${id}" is not a ${reviewed} rubric criterion`));
  }
  if (issues.length > 0) return issues;

  const total = [...scored.values()].reduce((sum, score) => sum + score, 0);
  const normalized = total / (2 * rubric.criteria.length);
  const criticalZero = rubric.criteria.some(
    (criterion) => criterion.critical && scored.get(criterion.id) === 0,
  );
  const expected = criticalZero || normalized < rubric.threshold ? 'revise' : 'accept';
  if (review.verdict !== expected) {
    issues.push(
      error(
        'rubric-verdict',
        `${reviewed} review scored ${normalized.toFixed(2)} (threshold ${rubric.threshold}${criticalZero ? ', a critical criterion scored 0' : ''}) so the verdict must be "${expected}", not "${review.verdict}"`,
      ),
    );
  }
  if (review.verdict === 'revise' && review.required_changes.length === 0) {
    issues.push(
      error('rubric-changes', `a "revise" verdict on ${reviewed} must list required_changes`),
    );
  }
  return issues;
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => (seen.has(value) ? true : (seen.add(value), false)));
}

export function checkDesign(design: DesignBrief): Issue[] {
  const issues: Issue[] = [];
  for (const id of duplicates(design.acceptance_criteria.map((criterion) => criterion.id))) {
    issues.push(error('ac-duplicate', `acceptance criterion ${id} is defined more than once`));
  }
  for (const question of design.blocking_questions) {
    issues.push(error('blocking-question', `escalate to a human before architecture: ${question}`));
  }
  for (const [state, text] of Object.entries(design.ux_states)) {
    if (/^n\/a/i.test(text.trim()) && !/^n\/a\s*:\s*\S/i.test(text.trim())) {
      issues.push(error('ux-state-reason', `ux_states.${state} is "n/a" without a reason`));
    }
  }
  const hasFrontend = design.surfaces.includes('frontend');
  const coversUsability = design.acceptance_criteria.some(
    (criterion) => criterion.kind === 'i18n' || criterion.kind === 'a11y',
  );
  if (hasFrontend && !coversUsability) {
    issues.push(
      warn('frontend-criteria', 'frontend surface without an i18n or a11y acceptance criterion'),
    );
  }
  return issues;
}

function workspaceOf(path: string, policy: Policy): string | undefined {
  return Object.entries(policy.workspaces)
    .filter(([, workspace]) => path === workspace.path || path.startsWith(`${workspace.path}/`))
    .sort(([, a], [, b]) => b.path.length - a.path.length)[0]?.[0];
}

export function checkPlan(plan: ArchitecturePlan, design: DesignBrief, policy: Policy): Issue[] {
  const issues = checkReview(plan.design_review, 'design', policy);
  if (plan.design_review.verdict === 'revise') {
    issues.push(
      error(
        'design-rejected',
        'the plan asked the design to be revised; return to the Design stage',
      ),
    );
  }
  if (plan.run_id !== design.run_id) {
    issues.push(
      error('run-id', `plan run_id ${plan.run_id} does not match design ${design.run_id}`),
    );
  }
  const packages = plan.work_packages;
  if (packages.length > policy.loop_limits.max_work_packages) {
    issues.push(
      error(
        'wp-limit',
        `${packages.length} work packages exceed the limit of ${policy.loop_limits.max_work_packages}`,
      ),
    );
  }
  for (const id of duplicates(packages.map((wp) => wp.id))) {
    issues.push(error('wp-duplicate', `work package ${id} is defined more than once`));
  }

  const designIds = new Set(design.acceptance_criteria.map((criterion) => criterion.id));
  const assigned = new Set<string>();
  const tested = new Set<string>();
  const defined = new Set<string>();
  const devScope = policy.stages.dev.write_scope;
  const scopeOwners = new Map<string, string>();

  for (const wp of packages) {
    for (const dependency of wp.depends_on) {
      if (!defined.has(dependency)) {
        issues.push(
          error('wp-order', `${wp.id} depends on ${dependency}, which must be defined earlier`),
        );
      }
    }
    defined.add(wp.id);
    for (const id of wp.acceptance_criteria) {
      assigned.add(id);
      if (!designIds.has(id))
        issues.push(
          error('ac-unknown', `${wp.id} references ${id}, which the design does not define`),
        );
    }
    for (const test of wp.tests) {
      for (const id of test.covers) {
        tested.add(id);
        if (!wp.acceptance_criteria.includes(id)) {
          issues.push(warn('test-scope', `${test.path} covers ${id}, which ${wp.id} does not own`));
        }
      }
      if (!matchesAny(test.path, wp.write_scope)) {
        issues.push(error('test-outside-scope', `${test.path} is outside ${wp.id} write_scope`));
      }
    }
    for (const glob of wp.write_scope) {
      const probe = globProbe(glob);
      if (!matchesAny(probe, devScope)) {
        issues.push(
          error(
            'scope-outside-dev',
            `${wp.id} write_scope "${glob}" is outside the Dev stage scope`,
          ),
        );
      }
      if (matchesAny(probe, policy.immutable_paths)) {
        issues.push(
          error('scope-immutable', `${wp.id} write_scope "${glob}" reaches an immutable path`),
        );
      }
      const owner = scopeOwners.get(glob);
      if (owner) issues.push(warn('scope-overlap', `"${glob}" is in both ${owner} and ${wp.id}`));
      scopeOwners.set(glob, wp.id);
    }
    for (const override of wp.protected_overrides) {
      if (matchesAny(override.path, policy.immutable_paths)) {
        issues.push(
          error('override-immutable', `${wp.id} cannot override immutable path ${override.path}`),
        );
      }
      if (!matchesAny(override.path, policy.protected_paths)) {
        issues.push(
          warn('override-unneeded', `${override.path} is not protected; drop the override`),
        );
      }
    }
    const touched = [
      ...wp.tests.map((test) => test.path),
      ...plan.modules
        .map((module) => module.path)
        .filter((path) => matchesAny(path, wp.write_scope)),
    ];
    const needed = new Set(
      touched
        .map((path) => workspaceOf(path, policy))
        .filter(
          (workspace): workspace is string =>
            workspace !== undefined && policy.workspaces[workspace].typecheck !== null,
        ),
    );
    for (const workspace of needed) {
      if (!wp.typecheck_workspaces.includes(workspace)) {
        issues.push(
          error(
            'typecheck-missing',
            `${wp.id} touches ${workspace} but does not list it in typecheck_workspaces`,
          ),
        );
      }
    }
    for (const workspace of wp.typecheck_workspaces) {
      if (!(workspace in policy.workspaces))
        issues.push(error('workspace-unknown', `${wp.id} lists unknown workspace ${workspace}`));
    }
  }

  for (const id of designIds) {
    if (!assigned.has(id))
      issues.push(error('ac-unassigned', `${id} is not assigned to any work package`));
    if (!tested.has(id))
      issues.push(error('ac-untested', `${id} is not covered by any planned test`));
  }
  for (const module of plan.modules) {
    if (!packages.some((wp) => matchesAny(module.path, wp.write_scope))) {
      issues.push(
        error('module-unowned', `${module.path} is not inside any work package write_scope`),
      );
    }
    if (module.workspace === 'api' && module.change === 'new') {
      issues.push(
        warn(
          'api-new-module',
          `${module.path}: new files under /api must be wiring only; behavior belongs in packages/api`,
        ),
      );
    }
  }
  if (design.config_levers.length > plan.config_fields.length) {
    issues.push(
      error(
        'config-levers',
        `the design names ${design.config_levers.length} config lever(s) but the plan adds ${plan.config_fields.length} configSchema field(s)`,
      ),
    );
  }
  if (plan.data_changes.migration_required && plan.risks.length === 0) {
    issues.push(
      warn('migration-risk', 'a migration is required but no risk/mitigation is recorded'),
    );
  }
  return issues;
}

/** Path guardrails shared by `guard` (git diff) and dev-report validation (declared files). */
export function checkPaths(
  files: string[],
  stage: Stage,
  policy: Policy,
  packages: WorkPackage[] = [],
): Issue[] {
  const stageScope = policy.stages[stage].write_scope;
  const packageScope = packages.flatMap((wp) => wp.write_scope);
  const overrides = new Set(
    packages.flatMap((wp) => wp.protected_overrides.map((override) => override.path)),
  );
  const issues: Issue[] = [];
  for (const file of files) {
    if (matchesAny(file, policy.immutable_paths)) {
      issues.push(error('immutable-path', `${file} is immutable for every agent stage`));
      continue;
    }
    if (matchesAny(file, policy.protected_paths) && !overrides.has(file)) {
      issues.push(
        error(
          'protected-path',
          `${file} is protected; the plan must grant a protected_override for it`,
        ),
      );
      continue;
    }
    if (!matchesAny(file, stageScope) && !overrides.has(file)) {
      issues.push(error('stage-scope', `${file} is outside the ${stage} stage write scope`));
      continue;
    }
    if (
      stage === 'dev' &&
      packages.length > 0 &&
      !matchesAny(file, packageScope) &&
      !overrides.has(file)
    ) {
      issues.push(
        error(
          'package-scope',
          `${file} is outside the write_scope of ${packages.map((wp) => wp.id).join(', ')}`,
        ),
      );
    }
  }
  return issues;
}

export function checkDev(report: DevReport, plan: ArchitecturePlan, policy: Policy): Issue[] {
  const issues = checkReview(report.plan_review, 'architect', policy);
  if (report.plan_review.verdict === 'revise') {
    issues.push(
      error(
        'plan-rejected',
        'the report asked the plan to be revised; return to the Architect stage',
      ),
    );
  }
  if (report.run_id !== plan.run_id)
    issues.push(error('run-id', `dev report run_id ${report.run_id} does not match the plan`));
  const wp = plan.work_packages.find((candidate) => candidate.id === report.work_package);
  if (!wp) return [...issues, error('wp-unknown', `${report.work_package} is not in the plan`)];

  issues.push(...checkPaths(report.files_changed, 'dev', policy, [wp]));
  if (report.files_changed.length > policy.loop_limits.max_files_per_work_package) {
    issues.push(
      warn(
        'wp-size',
        `${report.files_changed.length} files changed; limit is ${policy.loop_limits.max_files_per_work_package}`,
      ),
    );
  }
  for (const check of report.checks) {
    if (check.result === 'fail') issues.push(error('check-failed', `${check.command} failed`));
    if (check.result === 'not_run' && check.note.trim() === '') {
      issues.push(error('check-not-run', `${check.command} was not run and no reason was given`));
    }
  }
  for (const workspace of wp.typecheck_workspaces) {
    const path = policy.workspaces[workspace]?.path ?? workspace;
    const ran = report.checks.some(
      (check) =>
        check.result === 'pass' &&
        check.command.includes(path) &&
        /tsc|typecheck/.test(check.command),
    );
    if (!ran)
      issues.push(error('typecheck-not-run', `no passing typecheck recorded for ${workspace}`));
  }
  if (
    !report.checks.some(
      (check) => check.command.includes('static-checks') && check.result === 'pass',
    )
  ) {
    issues.push(error('static-checks-not-run', 'no passing `npm run static-checks` recorded'));
  }
  const status = new Map(report.criteria_status.map((entry) => [entry.id, entry.status]));
  for (const id of wp.acceptance_criteria) {
    const state = status.get(id);
    if (!state)
      issues.push(
        error('ac-status-missing', `${wp.id} owns ${id} but the report does not state it`),
      );
    if (state === 'not_started') issues.push(error('ac-not-started', `${id} is not started`));
    if (state === 'partial') issues.push(warn('ac-partial', `${id} is only partially implemented`));
  }
  return issues;
}

/** The head the Test stage must verify: the last dev report of the highest round, in plan order. */
export function latestDevReport(
  reports: DevReport[],
  plan: ArchitecturePlan,
): DevReport | undefined {
  const order = new Map(plan.work_packages.map((wp, index) => [wp.id, index]));
  return [...reports].sort(
    (a, b) =>
      a.round - b.round || (order.get(a.work_package) ?? 0) - (order.get(b.work_package) ?? 0),
  )[reports.length - 1];
}

export function checkTest(
  report: TestReport,
  design: DesignBrief,
  plan: ArchitecturePlan,
  devReports: DevReport[],
  policy: Policy,
): Issue[] {
  const issues = checkReview(report.implementation_review, 'dev', policy);
  if (report.run_id !== design.run_id)
    issues.push(error('run-id', `test report run_id ${report.run_id} does not match the design`));
  const latest = latestDevReport(devReports, plan);
  if (!latest) issues.push(error('dev-missing', 'no dev report to verify'));
  if (
    latest &&
    !latest.head_sha.startsWith(report.head_sha) &&
    !report.head_sha.startsWith(latest.head_sha)
  ) {
    issues.push(
      error(
        'head-mismatch',
        `tested ${report.head_sha} but the latest dev head is ${latest.head_sha}`,
      ),
    );
  }
  const results = new Map(report.criteria_results.map((result) => [result.id, result]));
  const designIds = design.acceptance_criteria.map((criterion) => criterion.id);
  for (const id of designIds) {
    if (!results.has(id)) issues.push(error('ac-result-missing', `${id} has no test result`));
  }
  for (const result of report.criteria_results) {
    if (result.status === 'untested' && result.note.trim() === '') {
      issues.push(error('untested-reason', `${result.id} is untested without a reason`));
    }
  }
  for (const finding of report.findings) {
    if (finding.criterion && !designIds.includes(finding.criterion)) {
      issues.push(
        warn(
          'finding-criterion',
          `finding at ${finding.location} names unknown criterion ${finding.criterion}`,
        ),
      );
    }
  }
  const allPass = designIds.every((id) => results.get(id)?.status === 'pass');
  const blocking = report.findings.some((finding) => finding.severity !== 'minor');
  const failedCheck = report.checks.some((check) => check.result === 'fail');
  const expected =
    allPass && !blocking && !failedCheck && report.implementation_review.verdict === 'accept'
      ? 'pass'
      : 'fail';
  if (report.verdict !== expected) {
    issues.push(
      error(
        'test-verdict',
        `verdict must be "${expected}" given the criteria results, findings, checks and review`,
      ),
    );
  }
  return issues;
}

/* ------------------------------------------------------------------------ */
/* Diff rules                                                                */
/* ------------------------------------------------------------------------ */

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** Parses `git diff -U0` output into the added lines of each file. */
export function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? '' : raw.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || !raw.startsWith('+')) continue;
    added.push({ file, line, text: raw.slice(1) });
    line++;
  }
  return added;
}

export function scanAddedLines(added: AddedLine[], rules: DiffRule[]): Issue[] {
  const compiled = rules.map((rule) => ({ rule, regex: new RegExp(rule.pattern) }));
  return added.flatMap(({ file, line, text }) =>
    compiled
      .filter(({ rule, regex }) => matchesAny(file, rule.files) && regex.test(text))
      .map(({ rule }) => ({
        severity: rule.severity,
        rule: rule.id,
        message: `${file}:${line}: ${rule.message}`,
      })),
  );
}

/* ------------------------------------------------------------------------ */
/* Workflow evals                                                            */
/* ------------------------------------------------------------------------ */

export interface Scenario {
  id: string;
  task: string;
  expect: {
    halts_at?: Stage;
    surfaces_include?: string[];
    criteria_kinds_include?: string[];
    module_workspaces_include?: string[];
    module_workspaces_exclude?: string[];
    forbid_new_modules?: string[];
    max_fix_rounds?: number;
    verdict?: 'pass' | 'fail';
  };
}

/** Scores a finished run against a benchmark scenario's expectations. */
export function evaluateScenario(scenario: Scenario, run: RunArtifacts): Issue[] {
  const { expect } = scenario;
  const issues: Issue[] = [];
  if (expect.halts_at) {
    const present: Record<Stage, boolean> = {
      design: run.design !== undefined,
      architect: run.plan !== undefined,
      dev: run.dev.length > 0,
      test: run.test !== undefined,
    };
    const next = STAGES[STAGES.indexOf(expect.halts_at) + 1];
    if (!present[expect.halts_at])
      issues.push(error('scenario-halt', `expected the run to reach ${expect.halts_at}`));
    if (next && present[next])
      issues.push(error('scenario-halt', `expected a halt at ${expect.halts_at}, but ${next} ran`));
    if (expect.halts_at === 'design' && run.design && run.design.blocking_questions.length === 0) {
      issues.push(error('scenario-escalation', 'expected the design to raise a blocking question'));
    }
    return issues;
  }
  const surfaces = run.design?.surfaces ?? [];
  for (const surface of expect.surfaces_include ?? []) {
    if (!surfaces.includes(surface))
      issues.push(error('scenario-surface', `design is missing surface ${surface}`));
  }
  const kinds = new Set(run.design?.acceptance_criteria.map((criterion) => criterion.kind) ?? []);
  for (const kind of expect.criteria_kinds_include ?? []) {
    if (!kinds.has(kind))
      issues.push(error('scenario-criteria', `design has no ${kind} acceptance criterion`));
  }
  const modules = run.plan?.modules ?? [];
  const workspaces = new Set(modules.map((module) => module.workspace));
  for (const workspace of expect.module_workspaces_include ?? []) {
    if (!workspaces.has(workspace))
      issues.push(error('scenario-placement', `plan places nothing in ${workspace}`));
  }
  for (const workspace of expect.module_workspaces_exclude ?? []) {
    if (workspaces.has(workspace))
      issues.push(error('scenario-placement', `plan should not touch ${workspace}`));
  }
  for (const module of modules) {
    if (module.change === 'new' && matchesAny(module.path, expect.forbid_new_modules ?? [])) {
      issues.push(error('scenario-placement', `plan adds forbidden new module ${module.path}`));
    }
  }
  const fixRounds = Math.max(0, ...run.dev.map((report) => report.round));
  if (expect.max_fix_rounds !== undefined && fixRounds > expect.max_fix_rounds) {
    issues.push(
      error('scenario-fix-rounds', `${fixRounds} fix round(s) exceed ${expect.max_fix_rounds}`),
    );
  }
  if (expect.verdict && run.test?.verdict !== expect.verdict) {
    issues.push(
      error(
        'scenario-verdict',
        `expected test verdict ${expect.verdict}, got ${run.test?.verdict ?? 'none'}`,
      ),
    );
  }
  return issues;
}

/* ------------------------------------------------------------------------ */
/* IO                                                                        */
/* ------------------------------------------------------------------------ */

export function loadPolicy(dir = WORKFLOW_DIR): Policy {
  return JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8'));
}

function loadContract(stage: Stage, policy: Policy, dir = WORKFLOW_DIR): JsonSchema {
  return JSON.parse(readFileSync(join(dir, policy.stages[stage].contract), 'utf8'));
}

interface Loaded<T> {
  file: string;
  value: T;
  issues: Issue[];
}

function loadArtifact<T>(file: string, schema: JsonSchema): Loaded<T> {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const issues = validateSchema(parsed, schema).map((message) => error('contract', message));
  return { file, value: parsed, issues };
}

function artifactFiles(runDir: string, stage: Stage, policy: Policy): string[] {
  if (!existsSync(runDir)) return [];
  const regex = globToRegExp(policy.stages[stage].artifact);
  return readdirSync(runDir)
    .filter((name) => regex.test(name))
    .sort()
    .map((name) => join(runDir, name));
}

/** Parses whatever artifacts a run directory holds, without validating them. */
export function loadRun(runDir: string, policy: Policy): RunArtifacts {
  const parse = <T,>(stage: Stage): T[] =>
    artifactFiles(runDir, stage, policy).map((file) => JSON.parse(readFileSync(file, 'utf8')));
  return {
    design: parse<DesignBrief>('design')[0],
    plan: parse<ArchitecturePlan>('architect')[0],
    dev: parse<DevReport>('dev'),
    test: parse<TestReport>('test')[0],
  };
}

export function loadScenarios(dir = WORKFLOW_DIR): Scenario[] {
  return JSON.parse(readFileSync(join(dir, 'evals/scenarios.json'), 'utf8')).scenarios;
}

export interface StageResult {
  stage: Stage;
  file: string;
  issues: Issue[];
}

/** Validates every artifact present in a run directory, upstream first. */
export function validateRun(
  runDir: string,
  stages: Stage[],
  policy: Policy,
  workflowDir = WORKFLOW_DIR,
): StageResult[] {
  const results: StageResult[] = [];
  const load = <T,>(stage: Stage): Loaded<T>[] =>
    artifactFiles(runDir, stage, policy).map((file) =>
      loadArtifact<T>(file, loadContract(stage, policy, workflowDir)),
    );

  const [design] = load<DesignBrief>('design');
  const [plan] = load<ArchitecturePlan>('architect');
  const devReports = load<DevReport>('dev');
  const [test] = load<TestReport>('test');
  const valid = <T,>(artifact: Loaded<T> | undefined): T | undefined =>
    artifact && artifact.issues.length === 0 ? artifact.value : undefined;
  const missing = (stage: Stage, needs: string): StageResult => ({
    stage,
    file: join(runDir, policy.stages[stage].artifact),
    issues: [error('upstream-missing', `needs a valid ${needs}`)],
  });

  for (const stage of stages) {
    if (stage === 'design') {
      if (!design) results.push(missing('design', policy.stages.design.artifact));
      else
        results.push({
          stage,
          file: design.file,
          issues: [...design.issues, ...(valid(design) ? checkDesign(design.value) : [])],
        });
      continue;
    }
    const designValue = valid(design);
    if (stage === 'architect') {
      if (!plan || !designValue) {
        results.push(missing('architect', `${policy.stages.architect.artifact} and design brief`));
        continue;
      }
      results.push({
        stage,
        file: plan.file,
        issues: [
          ...plan.issues,
          ...(valid(plan) ? checkPlan(plan.value, designValue, policy) : []),
        ],
      });
      continue;
    }
    const planValue = valid(plan);
    if (stage === 'dev') {
      if (devReports.length === 0 || !planValue) {
        results.push(missing('dev', `${policy.stages.dev.artifact} and architecture plan`));
        continue;
      }
      for (const report of devReports) {
        results.push({
          stage,
          file: report.file,
          issues: [
            ...report.issues,
            ...(valid(report) ? checkDev(report.value, planValue, policy) : []),
          ],
        });
      }
      continue;
    }
    if (!test || !designValue || !planValue) {
      results.push(
        missing('test', `${policy.stages.test.artifact}, design brief and architecture plan`),
      );
      continue;
    }
    const reports = devReports
      .filter((report) => report.issues.length === 0)
      .map((report) => report.value);
    results.push({
      stage,
      file: test.file,
      issues: [
        ...test.issues,
        ...(valid(test) ? checkTest(test.value, designValue, planValue, reports, policy) : []),
      ],
    });
  }
  return results;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

/** Changed files and added lines from the merge base of `against` to `head`, or to the working tree. */
export function collectDiff(
  against: string,
  head?: string,
): { files: string[]; added: AddedLine[] } {
  const range = head ? [`${against}...${head}`] : [against];
  const files = git(['diff', '--name-only', '--diff-filter=ACMRD', ...range])
    .split('\n')
    .filter(Boolean);
  const untracked = head
    ? []
    : git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const added = parseAddedLines(git(['diff', '-U0', '--no-color', ...range]));
  const untrackedLines = untracked.flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .map((text, index) => ({ file, line: index + 1, text })),
  );
  return { files: [...new Set([...files, ...untracked])], added: [...added, ...untrackedLines] };
}

/** Structural checks on the workflow definition itself, plus the worked example. */
export function checkPolicy(workflowDir = WORKFLOW_DIR): Issue[] {
  const policy = loadPolicy(workflowDir);
  const issues: Issue[] = [];
  for (const rule of policy.diff_rules) {
    try {
      new RegExp(rule.pattern);
    } catch (cause) {
      issues.push(error('rule-regex', `${rule.id}: ${String(cause)}`));
    }
  }
  for (const id of duplicates(policy.diff_rules.map((rule) => rule.id))) {
    issues.push(error('rule-duplicate', `diff rule ${id} is defined more than once`));
  }
  for (const [stage, rubric] of Object.entries(policy.rubrics)) {
    if (rubric.threshold <= 0 || rubric.threshold > 1)
      issues.push(error('rubric-threshold', `${stage} threshold must be in (0, 1]`));
    if (!rubric.criteria.some((criterion) => criterion.critical))
      issues.push(warn('rubric-critical', `${stage} rubric has no critical criterion`));
  }
  for (const stage of Object.keys(policy.stages) as Stage[]) {
    if (!existsSync(join(workflowDir, policy.stages[stage].contract))) {
      issues.push(error('contract-missing', `${policy.stages[stage].contract} does not exist`));
    }
    for (const glob of policy.stages[stage].write_scope) {
      if (matchesAny(globProbe(glob), policy.immutable_paths)) {
        issues.push(
          error('scope-immutable', `${stage} write_scope "${glob}" overlaps an immutable path`),
        );
      }
    }
  }
  const scenarios = loadScenarios(workflowDir);
  for (const id of duplicates(scenarios.map((scenario) => scenario.id))) {
    issues.push(error('scenario-duplicate', `scenario ${id} is defined more than once`));
  }
  for (const scenario of scenarios) {
    if (scenario.expect.halts_at && !STAGES.includes(scenario.expect.halts_at)) {
      issues.push(
        error(
          'scenario-stage',
          `${scenario.id} halts at unknown stage ${scenario.expect.halts_at}`,
        ),
      );
    }
  }
  const example = join(workflowDir, 'examples');
  const stages: Stage[] = ['design', 'architect', 'dev', 'test'];
  for (const result of validateRun(example, stages, policy, workflowDir)) {
    issues.push(
      ...result.issues.map((issue) => ({
        ...issue,
        message: `example ${result.stage}: ${issue.message}`,
      })),
    );
  }
  return issues;
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                       */
/* ------------------------------------------------------------------------ */

function report(issues: Issue[], heading?: string): boolean {
  if (heading) console.log(heading);
  for (const issue of issues) {
    console.log(`  ${issue.severity === 'error' ? '✗' : '!'} [${issue.rule}] ${issue.message}`);
  }
  const failed = issues.some((issue) => issue.severity === 'error');
  if (heading && !failed) console.log(`  ✓ ${issues.length === 0 ? 'ok' : 'ok with warnings'}`);
  return failed;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseStage(value: string | undefined, allowAll = false): Stage[] {
  if (allowAll && value === 'all') return STAGES;
  const stage = STAGES.find((candidate) => candidate === value);
  if (!stage)
    throw new Error(`stage must be one of ${STAGES.join(', ')}${allowAll ? ', all' : ''}`);
  return [stage];
}

function describe(stage: Stage, policy: Policy): Json {
  const reviews: Record<Stage, keyof Policy['rubrics'] | null> = {
    design: null,
    architect: 'design',
    dev: 'architect',
    test: 'dev',
  };
  const upstream = reviews[stage];
  const ownRubric = stage === 'test' ? null : policy.rubrics[stage];
  return JSON.parse(
    JSON.stringify({
      stage,
      artifact: policy.stages[stage].artifact,
      contract: loadContract(stage, policy),
      rubric_you_score: upstream ? { stage: upstream, ...policy.rubrics[upstream] } : null,
      rubric_you_are_scored_on: ownRubric
        ? { by: policy.stages[stage].reviewed_by, ...ownRubric }
        : null,
      write_scope: policy.stages[stage].write_scope,
      immutable_paths: policy.immutable_paths,
      protected_paths: policy.protected_paths,
      loop_limits: policy.loop_limits,
      diff_rules: policy.diff_rules.map(({ id, severity, message }) => ({ id, severity, message })),
    }),
  );
}

function main(args: string[]): number {
  const [command, stageArg] = args;
  const policy = loadPolicy();
  const runDir = option(args, '--run');

  if (command === 'describe') {
    console.log(JSON.stringify(describe(parseStage(stageArg)[0], policy), null, 2));
    return 0;
  }
  if (command === 'check-policy') {
    return report(checkPolicy(), 'Workflow policy, contracts and example run') ? 1 : 0;
  }
  if (command === 'validate') {
    if (!runDir) throw new Error('validate needs --run <dir>');
    const results = validateRun(resolve(runDir), parseStage(stageArg, true), policy);
    const failed = results.map((result) =>
      report(result.issues, `${result.stage}: ${result.file}`),
    );
    return failed.some(Boolean) ? 1 : 0;
  }
  if (command === 'eval-scenario') {
    if (!runDir) throw new Error('eval-scenario needs --run <dir>');
    const scenario = loadScenarios().find((candidate) => candidate.id === stageArg);
    if (!scenario)
      throw new Error(`unknown scenario ${stageArg}; see .agents/workflow/evals/scenarios.json`);
    const issues = evaluateScenario(scenario, loadRun(resolve(runDir), policy));
    return report(issues, `scenario ${scenario.id}: ${runDir}`) ? 1 : 0;
  }
  if (command === 'guard') {
    const [stage] = parseStage(stageArg);
    const against = option(args, '--against');
    if (!against) throw new Error('guard needs --against <ref>');
    const { files, added } = collectDiff(against, option(args, '--head'));
    const planFile = runDir ? artifactFiles(resolve(runDir), 'architect', policy)[0] : undefined;
    const plan = planFile
      ? loadArtifact<ArchitecturePlan>(planFile, loadContract('architect', policy))
      : undefined;
    const only = option(args, '--work-package');
    const packages =
      plan && plan.issues.length === 0
        ? plan.value.work_packages.filter((wp) => !only || wp.id === only)
        : [];
    const issues = [
      ...checkPaths(files, stage, policy, stage === 'dev' ? packages : []),
      ...scanAddedLines(added, policy.diff_rules),
    ];
    return report(issues, `${stage} guard: ${files.length} changed file(s) against ${against}`)
      ? 1
      : 0;
  }
  console.log(
    'usage: agent-workflow.mts <describe|validate|guard|eval-scenario|check-policy> [stage|all|scenario] [--run dir] [--against ref] [--head ref] [--work-package WP-n]',
  );
  return command ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
