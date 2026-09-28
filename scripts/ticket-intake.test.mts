import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Ticket, TicketConfig } from './ticket-intake.mts';

import {
  azureDevOps,
  htmlToText,
  loadTicketConfig,
  next,
  readyQuery,
  toTask,
} from './ticket-intake.mts';

const config: TicketConfig = loadTicketConfig();
const env = { ADO_ORG_URL: 'https://dev.azure.com/contoso/', ADO_PROJECT: 'Chat', ADO_PAT: 'pat' };

interface Call {
  method: string;
  url: string;
  body: unknown;
  type: string;
}

function fakeAdo(
  items: Record<number, { rev: number; state: string; fields?: object }>,
  conflict = false,
) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body, type: headers['Content-Type'] });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.includes('/wiql'))
      return json({
        workItems: Object.entries(items)
          .filter(([, item]) => item.state === config.states.ready)
          .map(([id]) => ({ id: Number(id) })),
      });
    const id = Number(url.match(/workitems\/(\d+)/i)?.[1]);
    if (url.includes('/comments')) return json({ id: 1 });
    if (init.method === 'PATCH') {
      if (conflict) {
        items[id].state = config.states.in_progress;
        return json({ message: 'rev mismatch' }, 400);
      }
      return json({ id });
    }
    return json({
      id,
      rev: items[id].rev,
      fields: {
        'System.State': items[id].state,
        'System.WorkItemType': 'User Story',
        'System.Title': 'Show a character counter',
        'System.Description': '<div>Users hit the limit&nbsp;blind.<br>Show a counter.</div>',
        'Microsoft.VSTS.Common.AcceptanceCriteria':
          '<ul><li>Counter shows at 80%</li><li>Hidden when off</li></ul>',
        'System.Tags': 'ui; composer',
        ...items[id].fields,
      },
      _links: { html: { href: `https://dev.azure.com/contoso/Chat/_workitems/edit/${id}` } },
    });
  };
  return { calls, source: azureDevOps(config, env, fetcher) };
}

test('rich-text ticket fields become plain text', () => {
  assert.equal(
    htmlToText('<div>A &amp; B<br/>C</div><ul><li>one</li><li>two&#39;s</li></ul>'),
    "A & B\nC\n\n- one\n- two's",
  );
});

test('the ready query filters project, state and types and escapes quotes', () => {
  const query = readyQuery(
    { ...config, azure_devops: { ...config.azure_devops, area_path: "O'Neil" } },
    'Chat',
  );
  assert.match(query, /\[System.State\] = 'AI_Ready'/);
  assert.match(query, /\[System.TeamProject\] = 'Chat'/);
  assert.match(query, /\[System.AreaPath\] UNDER 'O''Neil'/);
  assert.match(query, /\[System.WorkItemType\] IN \('User Story'/);
});

test('missing credentials fail before any request', () => {
  assert.throws(() => azureDevOps(config, { ADO_PROJECT: 'Chat' }), /ADO_ORG_URL, ADO_PAT/);
});

test('a ticket becomes a traceable workflow task', () => {
  const ticket: Ticket = {
    provider: 'azure_devops',
    id: 42,
    rev: 3,
    type: 'Bug',
    title: 'Fix it',
    url: 'https://dev.azure.com/contoso/Chat/_workitems/edit/42',
    description: 'Broken',
    acceptance_criteria: '',
    tags: [],
  };
  const task = toTask(ticket, config, new Date('2026-09-28T10:00:00Z'));
  assert.equal(task.run_id, '20260928-ado-42');
  assert.equal(task.repo, config.repo);
  assert.equal(task.base, config.base);
  assert.deepEqual(task.ticket, {
    provider: 'azure_devops',
    id: 42,
    url: ticket.url,
    title: 'Fix it',
  });
  assert.match(task.task, /Broken/);
  assert.match(task.task, /\(none on the ticket\)/);
});

test('next claims the first ready item with a rev-guarded patch and comments on it', async () => {
  const { calls, source } = fakeAdo({
    7: { rev: 5, state: 'AI_Ready' },
    9: { rev: 1, state: 'Active' },
  });
  const task = await next(source, config);
  assert.equal(task?.ticket.id, 7);
  assert.match(task?.task ?? '', /- Counter shows at 80%/);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch?.type, 'application/json-patch+json');
  assert.deepEqual(patch?.body, [
    { op: 'test', path: '/rev', value: 5 },
    { op: 'add', path: '/fields/System.State', value: 'AI_In_Progress' },
    { op: 'add', path: '/fields/System.Tags', value: 'ui; composer; software-factory' },
  ]);
  assert.ok(calls.some((call) => call.url.includes('/workItems/7/comments')));
  assert.ok(calls[0].url.startsWith('https://dev.azure.com/contoso/Chat/_apis/wit/wiql'));
});

test('an item claimed by another poller is skipped, a dry run claims nothing', async () => {
  const raced = fakeAdo({ 7: { rev: 5, state: 'AI_Ready' } }, true);
  assert.equal(await next(raced.source, config), null);
  const dry = fakeAdo({ 7: { rev: 5, state: 'AI_Ready' } });
  assert.equal((await next(dry.source, config, true))?.ticket.id, 7);
  assert.ok(!dry.calls.some((call) => call.method !== 'GET' && !call.url.includes('/wiql')));
});

test('report moves the item and links the pull request', async () => {
  const { calls, source } = fakeAdo({ 7: { rev: 6, state: 'AI_In_Progress' } });
  await source.report(7, 'review', 'Done.', 'https://github.com/o/r/pull/3');
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch?.body, [
    { op: 'add', path: '/fields/System.State', value: 'AI_Review' },
    {
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'Hyperlink',
        url: 'https://github.com/o/r/pull/3',
        attributes: { comment: 'Software Factory PR' },
      },
    },
  ]);
  const comment = calls.find((call) => call.url.includes('/comments'));
  assert.deepEqual(comment?.body, { text: 'Done.\n\nPull request: https://github.com/o/r/pull/3' });
});
