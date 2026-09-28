import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Ticket, TicketConfig } from './ticket-intake.mts';

import {
  adoLocation,
  azureDevOps,
  htmlToText,
  isReady,
  loadTicketConfig,
  movePatch,
  next,
  readyQuery,
  toTask,
} from './ticket-intake.mts';

const tagConfig: TicketConfig = { ...loadTicketConfig(), trigger: 'tag', state_moves: {} };
const stateConfig: TicketConfig = { ...tagConfig, trigger: 'state' };
const env = { ADO_ORG_URL: 'https://dev.azure.com/contoso/', ADO_PROJECT: 'Chat', ADO_PAT: 'pat' };

interface Item {
  rev: number;
  state: string;
  tags: string;
  type?: string;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
  type: string;
}

/** In-memory Azure DevOps: WIQL returns every item, so `next` must filter on readiness itself. */
function fakeAdo(config: TicketConfig, items: Record<number, Item>, raceOnPatch = false) {
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
      return json({ workItems: Object.keys(items).map((id) => ({ id: Number(id) })) });
    const id = Number(url.match(/workitems\/(\d+)/i)?.[1]);
    if (url.includes('/comments')) return json({ id: 1 });
    if (init.method === 'PATCH') {
      if (raceOnPatch) {
        items[id] = {
          ...items[id],
          state: 'Active',
          tags: 'AI_In_Progress',
          rev: items[id].rev + 1,
        };
        return json({ message: 'rev mismatch' }, 400);
      }
      return json({ id });
    }
    return json({
      id,
      rev: items[id].rev,
      fields: {
        'System.State': items[id].state,
        'System.WorkItemType': items[id].type ?? 'User Story',
        'System.Title': 'Show a character counter',
        'System.Description': '<div>Users hit the limit&nbsp;blind.<br>Show a counter.</div>',
        'Microsoft.VSTS.Common.AcceptanceCriteria':
          '<ul><li>Counter shows at 80%</li><li>Hidden when off</li></ul>',
        'System.Tags': items[id].tags,
      },
      _links: { html: { href: `https://dev.azure.com/contoso/Chat/_workitems/edit/${id}` } },
    });
  };
  return { calls, source: azureDevOps(config, env, fetcher) };
}

const patches = (calls: Call[]) => calls.filter((call) => call.method === 'PATCH');

test('rich-text ticket fields become plain text', () => {
  assert.equal(
    htmlToText('<div>A &amp; B<br/>C</div><ul><li>one</li><li>two&#39;s</li></ul>'),
    "A & B\nC\n\n- one\n- two's",
  );
});

test('the ready query matches the ready tag or state and escapes quotes', () => {
  const area = { ...tagConfig.azure_devops, area_path: "O'Neil" };
  const tagQuery = readyQuery({ ...tagConfig, azure_devops: area }, 'Chat');
  assert.match(tagQuery, /\[System.Tags\] CONTAINS 'AI_Ready'/);
  assert.match(tagQuery, /\[System.TeamProject\] = 'Chat'/);
  assert.match(tagQuery, /\[System.AreaPath\] UNDER 'O''Neil'/);
  assert.match(tagQuery, /\[System.WorkItemType\] IN \('User Story'/);
  assert.match(readyQuery(stateConfig, 'Chat'), /\[System.State\] = 'AI_Ready'/);
});

test('readiness is an exact tag or state match', () => {
  assert.ok(isReady({ state: 'New', tags: ['ui', 'ai_ready'] }, tagConfig));
  assert.ok(!isReady({ state: 'New', tags: ['AI_Ready_later'] }, tagConfig));
  assert.ok(isReady({ state: 'AI_Ready', tags: [] }, stateConfig));
  assert.ok(!isReady({ state: 'New', tags: ['AI_Ready'] }, stateConfig));
});

test('a move swaps the lifecycle tag and applies the configured state for the type', () => {
  const config = { ...tagConfig, state_moves: { Bug: { in_progress: 'Dev-In-Progress' } } };
  assert.deepEqual(movePatch({ type: 'Bug', tags: ['ui', 'AI_Ready'] }, 'in_progress', config), [
    { op: 'add', path: '/fields/System.State', value: 'Dev-In-Progress' },
    { op: 'add', path: '/fields/System.Tags', value: 'ui; software-factory; AI_In_Progress' },
  ]);
  assert.deepEqual(movePatch({ type: 'Task', tags: ['AI_In_Progress'] }, 'blocked', config), [
    { op: 'add', path: '/fields/System.Tags', value: 'software-factory; AI_Blocked' },
  ]);
  assert.deepEqual(movePatch({ type: 'Task', tags: [] }, 'review', stateConfig), [
    { op: 'add', path: '/fields/System.State', value: 'AI_Review' },
    { op: 'add', path: '/fields/System.Tags', value: 'software-factory' },
  ]);
});

test('missing credentials fail before any request', () => {
  assert.throws(() => azureDevOps(tagConfig, { ADO_PROJECT: 'Chat' }), /ADO_ORG_URL, ADO_PAT/);
});

test('organization and project are read from pasted Azure DevOps URLs', () => {
  const repoUrl = 'https://dev.azure.com/contoso/My%20Project/_git/web';
  assert.deepEqual(adoLocation(repoUrl, repoUrl), {
    orgUrl: 'https://dev.azure.com/contoso',
    project: 'My Project',
  });
  assert.deepEqual(adoLocation('https://dev.azure.com/contoso/', 'Chat'), {
    orgUrl: 'https://dev.azure.com/contoso',
    project: 'Chat',
  });
  assert.deepEqual(adoLocation('https://contoso.visualstudio.com/Chat/_boards', undefined), {
    orgUrl: 'https://contoso.visualstudio.com',
    project: 'Chat',
  });
});

test('a ticket becomes a traceable workflow task', () => {
  const ticket: Ticket = {
    provider: 'azure_devops',
    id: 42,
    rev: 3,
    type: 'Bug',
    state: 'New',
    title: 'Fix it',
    url: 'https://dev.azure.com/contoso/Chat/_workitems/edit/42',
    description: 'Broken',
    acceptance_criteria: '',
    tags: [],
  };
  const task = toTask(ticket, tagConfig, new Date('2026-09-28T10:00:00Z'));
  assert.equal(task.run_id, '20260928-ado-42');
  assert.equal(task.repo, tagConfig.repo);
  assert.equal(task.base, tagConfig.base);
  assert.deepEqual(task.ticket, {
    provider: 'azure_devops',
    id: 42,
    url: ticket.url,
    title: 'Fix it',
  });
  assert.match(task.task, /Broken/);
  assert.match(task.task, /\(none on the ticket\)/);
});

test('next skips items that are not ready and claims the first ready one with a rev guard', async () => {
  const { calls, source } = fakeAdo(tagConfig, {
    5: { rev: 2, state: 'New', tags: 'AI_Review' },
    7: { rev: 5, state: 'New', tags: 'ui; AI_Ready' },
  });
  const task = await next(source, tagConfig);
  assert.equal(task?.ticket.id, 7);
  assert.match(task?.task ?? '', /- Counter shows at 80%/);
  const [claim] = patches(calls);
  assert.equal(claim.type, 'application/json-patch+json');
  assert.deepEqual(claim.body, [
    { op: 'test', path: '/rev', value: 5 },
    { op: 'add', path: '/fields/System.Tags', value: 'ui; software-factory; AI_In_Progress' },
  ]);
  assert.ok(calls.some((call) => call.url.includes('/workItems/7/comments')));
  assert.ok(calls[0].url.startsWith('https://dev.azure.com/contoso/Chat/_apis/wit/wiql'));
});

test('an item claimed by another poller is skipped, a dry run claims nothing', async () => {
  const raced = fakeAdo(tagConfig, { 7: { rev: 5, state: 'New', tags: 'AI_Ready' } }, true);
  assert.equal(await next(raced.source, tagConfig), null);
  assert.ok(!raced.calls.some((call) => call.url.includes('/comments')));
  const dry = fakeAdo(tagConfig, { 7: { rev: 5, state: 'New', tags: 'AI_Ready' } });
  assert.equal((await next(dry.source, tagConfig, true))?.ticket.id, 7);
  assert.equal(patches(dry.calls).length, 0);
});

test('report moves the item and links the pull request', async () => {
  const { calls, source } = fakeAdo(tagConfig, {
    7: { rev: 6, state: 'New', tags: 'software-factory; AI_In_Progress' },
  });
  await source.report(7, 'review', 'Done.', 'https://github.com/o/r/pull/3');
  assert.deepEqual(patches(calls)[0].body, [
    { op: 'add', path: '/fields/System.Tags', value: 'software-factory; AI_Review' },
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
