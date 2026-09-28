#!/usr/bin/env node
/**
 * Ticket intake for the autonomous workflow (.agents/workflow/README.md > Ticket intake).
 *
 * Picks the next work item in the configured ready state, claims it, and writes
 * .agents/runs/task.json for .devin/skills/autonomous-workflow/workflow.py; reports
 * the run outcome back to the ticket. Configuration: .agents/workflow/tickets.json.
 *
 *   node scripts/ticket-intake.mts next [--dry-run]
 *   node scripts/ticket-intake.mts task <id>
 *   node scripts/ticket-intake.mts report <id> --outcome review|blocked [--pr-url url] [--message text]
 *
 * `next` prints {"ticket": null} when nothing is ready. Exits 1 on API or config errors.
 */

import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'api-version=7.1';

export type Outcome = 'review' | 'blocked';

export interface TicketConfig {
  provider: 'azure_devops';
  repo: string;
  base: string;
  azure_devops: {
    org_url_env: string;
    project_env: string;
    pat_env: string;
    work_item_types: string[];
    area_path: string | null;
    fields: {
      title: string;
      description: string;
      acceptance_criteria: string;
      repro_steps: string;
    };
  };
  states: { ready: string; in_progress: string; review: string; blocked: string };
  tag: string;
}

export interface Ticket {
  provider: 'azure_devops';
  id: number;
  rev: number;
  type: string;
  title: string;
  url: string;
  description: string;
  acceptance_criteria: string;
  tags: string[];
}

export interface Task {
  run_id: string;
  repo: string;
  base: string;
  task: string;
  open_pr: boolean;
  ticket: { provider: string; id: number; url: string; title: string };
}

export interface TicketSource {
  listReady(): Promise<number[]>;
  get(id: number): Promise<Ticket>;
  /** Moves a ready ticket to in-progress; false when another poller claimed it first. */
  claim(ticket: Ticket, runId: string): Promise<boolean>;
  report(id: number, outcome: Outcome, message: string, prUrl?: string): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, string | number | undefined>;
  _links?: { html?: { href: string } };
}

export function loadTicketConfig(): TicketConfig {
  return JSON.parse(readFileSync(join(ROOT, '.agents/workflow/tickets.json'), 'utf8'));
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Plain text from the HTML Azure DevOps stores in rich-text fields. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(p|div|h[1-6]|tr|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (match, entity: string) =>
      entity.startsWith('#')
        ? String.fromCharCode(Number(entity.slice(1)))
        : (ENTITIES[entity.toLowerCase()] ?? match),
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const wiqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export function readyQuery(config: TicketConfig, project: string): string {
  const clauses = [
    `[System.TeamProject] = ${wiqlString(project)}`,
    `[System.State] = ${wiqlString(config.states.ready)}`,
    `[System.WorkItemType] IN (${config.azure_devops.work_item_types.map(wiqlString).join(', ')})`,
  ];
  if (config.azure_devops.area_path)
    clauses.push(`[System.AreaPath] UNDER ${wiqlString(config.azure_devops.area_path)}`);
  return (
    'SELECT [System.Id] FROM WorkItems WHERE ' +
    clauses.join(' AND ') +
    ' ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.CreatedDate] ASC'
  );
}

/**
 * Organization URL and project name. Either value may be pasted as any Azure DevOps URL
 * (project, board or repo page); `https://dev.azure.com/<org>/<project>/...` and
 * `https://<org>.visualstudio.com/<project>/...` are understood.
 */
export function adoLocation(
  org: string | undefined,
  project: string | undefined,
): { orgUrl?: string; project?: string } {
  const parse = (value: string) => {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const hosted = url.hostname === 'dev.azure.com';
    const orgSegments = hosted ? segments.slice(0, 1) : [];
    const orgPath = orgSegments.map(encodeURIComponent).join('/');
    return {
      orgUrl: `${url.origin}${orgPath ? `/${orgPath}` : ''}`,
      project: segments[orgSegments.length],
    };
  };
  const fromOrg =
    org && /^https?:\/\//.test(org) ? parse(org) : { orgUrl: org, project: undefined };
  const fromProject = project && /^https?:\/\//.test(project) ? parse(project) : null;
  return {
    orgUrl: fromOrg.orgUrl ?? fromProject?.orgUrl,
    project: fromProject ? fromProject.project : project || fromOrg.project,
  };
}

export function azureDevOps(
  config: TicketConfig,
  env: Record<string, string | undefined> = process.env,
  fetcher: Fetch = fetch,
): TicketSource {
  const ado = config.azure_devops;
  const { orgUrl, project } = adoLocation(env[ado.org_url_env], env[ado.project_env]);
  const pat = env[ado.pat_env];
  const missing = [
    [ado.org_url_env, orgUrl],
    [ado.project_env, project],
    [ado.pat_env, pat],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !orgUrl || !project || !pat)
    throw new Error(`missing environment: ${missing.join(', ')}`);
  const base = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit`;
  const auth = 'Basic ' + Buffer.from(`:${pat}`).toString('base64');

  async function call<T>(
    method: string,
    url: string,
    body?: unknown,
    type = 'application/json',
  ): Promise<{ ok: boolean; status: number; value: T }> {
    const response = await fetcher(url, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': type },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const value = (text ? JSON.parse(text) : null) as T;
    return { ok: response.ok, status: response.status, value };
  }

  async function must<T>(method: string, url: string, body?: unknown, type?: string): Promise<T> {
    const result = await call<T>(method, url, body, type);
    if (!result.ok)
      throw new Error(`${method} ${url} -> ${result.status}: ${JSON.stringify(result.value)}`);
    return result.value;
  }

  const comment = (id: number, text: string) =>
    must('POST', `${base}/workItems/${id}/comments?format=markdown&api-version=7.1-preview.4`, {
      text,
    });

  return {
    async listReady() {
      const result = await must<{ workItems: { id: number }[] }>(
        'POST',
        `${base}/wiql?$top=20&${API}`,
        { query: readyQuery(config, project) },
      );
      return result.workItems.map((item) => item.id);
    },

    async get(id) {
      const item = await must<WorkItem>('GET', `${base}/workitems/${id}?${API}`);
      const field = (name: string) => String(item.fields[name] ?? '');
      const type = field('System.WorkItemType');
      const description = htmlToText(
        field(ado.fields.description) || (type === 'Bug' ? field(ado.fields.repro_steps) : ''),
      );
      return {
        provider: 'azure_devops',
        id: item.id,
        rev: item.rev,
        type,
        title: field(ado.fields.title),
        url:
          item._links?.html?.href ??
          `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
        description,
        acceptance_criteria: htmlToText(field(ado.fields.acceptance_criteria)),
        tags: field('System.Tags')
          .split(';')
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
    },

    async claim(ticket, runId) {
      const patch = [
        { op: 'test', path: '/rev', value: ticket.rev },
        { op: 'add', path: '/fields/System.State', value: config.states.in_progress },
        {
          op: 'add',
          path: '/fields/System.Tags',
          value: [...new Set([...ticket.tags, config.tag])].join('; '),
        },
      ];
      const result = await call<unknown>(
        'PATCH',
        `${base}/workitems/${ticket.id}?${API}`,
        patch,
        'application/json-patch+json',
      );
      if (!result.ok) {
        const current = await must<WorkItem>('GET', `${base}/workitems/${ticket.id}?${API}`);
        if (current.fields['System.State'] !== config.states.ready) return false;
        throw new Error(`claim #${ticket.id} -> ${result.status}: ${JSON.stringify(result.value)}`);
      }
      await comment(
        ticket.id,
        `Picked up by the Software Factory as run \`${runId}\`: Design → Architect → Dev → Test → PR.`,
      );
      return true;
    },

    async report(id, outcome, message, prUrl) {
      const patch: object[] = [
        { op: 'add', path: '/fields/System.State', value: config.states[outcome] },
      ];
      if (prUrl)
        patch.push({
          op: 'add',
          path: '/relations/-',
          value: { rel: 'Hyperlink', url: prUrl, attributes: { comment: 'Software Factory PR' } },
        });
      await must('PATCH', `${base}/workitems/${id}?${API}`, patch, 'application/json-patch+json');
      await comment(id, message + (prUrl ? `\n\nPull request: ${prUrl}` : ''));
    },
  };
}

export function toTask(ticket: Ticket, config: TicketConfig, date = new Date()): Task {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  const sections = [
    `Azure DevOps ${ticket.type} #${ticket.id}: ${ticket.title}`,
    `Ticket: ${ticket.url}`,
    '## Requirement',
    ticket.description || '(no description on the ticket)',
    '## Acceptance criteria (from the ticket)',
    ticket.acceptance_criteria || '(none on the ticket)',
    'The ticket is the source of truth. Carry every ticket acceptance criterion into the design ' +
      'brief. If the ticket is missing information a correct design needs, record blocking ' +
      'questions instead of guessing; they are posted back to the ticket.',
  ];
  return {
    run_id: `${day}-ado-${ticket.id}`,
    repo: config.repo,
    base: config.base,
    task: sections.join('\n\n'),
    open_pr: true,
    ticket: { provider: ticket.provider, id: ticket.id, url: ticket.url, title: ticket.title },
  };
}

function writeTask(task: Task): string {
  const dir = join(ROOT, '.agents/runs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'task.json');
  writeFileSync(file, JSON.stringify(task, null, 2) + '\n');
  return file;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Claims the first ready ticket nobody else claimed and writes its task.json. */
export async function next(
  source: TicketSource,
  config: TicketConfig,
  dryRun = false,
): Promise<Task | null> {
  for (const id of await source.listReady()) {
    const ticket = await source.get(id);
    const task = toTask(ticket, config);
    if (dryRun || (await source.claim(ticket, task.run_id))) return task;
  }
  return null;
}

export async function main(args: string[]): Promise<number> {
  const [command, id] = args;
  const config = loadTicketConfig();
  const source = azureDevOps(config);
  if (command === 'next') {
    const dryRun = args.includes('--dry-run');
    const task = await next(source, config, dryRun);
    const file = task && !dryRun ? writeTask(task) : null;
    console.log(JSON.stringify({ ticket: task?.ticket ?? null, run_id: task?.run_id, file }));
    return 0;
  }
  if (command === 'task' && id) {
    console.log(JSON.stringify(toTask(await source.get(Number(id)), config), null, 2));
    return 0;
  }
  const outcome = option(args, '--outcome');
  if (command === 'report' && id && (outcome === 'review' || outcome === 'blocked')) {
    await source.report(
      Number(id),
      outcome,
      option(args, '--message') ?? `Software Factory run finished: ${outcome}.`,
      option(args, '--pr-url'),
    );
    return 0;
  }
  console.error(
    'usage: ticket-intake.mts next [--dry-run] | task <id> | report <id> --outcome review|blocked [--pr-url url] [--message text]',
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
