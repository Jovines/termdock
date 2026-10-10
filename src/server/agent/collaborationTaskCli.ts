import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CollaborationError } from './collaborationProtocol.js';
import { taskPurpose, taskPurposeFilter } from './collaborationTaskPurpose.js';
import type { CollaborationCliIO, CollaborationCommand } from './collaborationCli.js';

export async function executeTaskCommand(command: CollaborationCommand,
  request: (method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  io: CollaborationCliIO): Promise<Record<string, unknown>> {
  const o = command.options, operation = command.operation!;
  const bodyOptions = ['content', 'file', 'stdin', 'idempotency-key'];
  const originOptions = ['source', 'external-actor', 'external-message-id', 'metadata'];
  if (originOptions.some(key => o[key]) && !o.principal) throw new Error('External source metadata requires --principal');
  const allowed: Record<string, string[]> = {
    list: ['group', 'purpose'], get: [], configure: [...bodyOptions, 'purpose', 'revision'], create: [...bodyOptions, 'purpose', 'group', 'title', 'constraints', 'acceptance', 'assignee', 'coordinator', 'parent', 'depends-on', 'managed', 'reviewers', 'shared-directory', 'integration', 'work-type'],
    answer: [...bodyOptions, 'decision'], respond: [...bodyOptions, 'attempt', 'to-event', 'evidence'],
    assign: [...bodyOptions, 'assignee', 'revision'], report: [...bodyOptions, 'attempt', 'status', 'evidence', 'summary'], ask: [...bodyOptions, 'attempt', 'options'],
    plan: [...bodyOptions, 'attempt', 'evidence'], review: [...bodyOptions, 'artifact', 'evidence', 'verdict'], comment: bodyOptions,
    'request-review': [...bodyOptions, 'artifact', 'assignee', 'revision'],
    revise: [...bodyOptions, 'revision'], close: [...bodyOptions, 'revision'], reopen: [...bodyOptions, 'revision'],
    coordinate: [...bodyOptions, 'revision'], pause: [...bodyOptions, 'revision'], resume: [...bodyOptions, 'revision'], retry: [...bodyOptions, 'revision'],
  };
  for (const flag of Object.keys(o)) if (![...allowed[operation], ...(o.principal ? originOptions : []), 'principal', 'session', 'json', 'jsonl', 'text', 'help'].includes(flag)) throw new Error(`--${flag} is not supported by task ${operation}`);
  if (o.purpose !== undefined) (operation === 'list' ? taskPurposeFilter : taskPurpose)(o.purpose);
  if (operation === 'configure' && o.purpose === undefined) throw new Error('configure requires --purpose interactive|automation');
  if (o.purpose !== undefined || operation === 'configure') {
    const capabilities = await request('GET', '/capabilities');
    const features = o.principal ? capabilities : capabilities.task_workflow as Record<string, unknown> | undefined;
    if (features?.background_task_records !== true || features.task_purpose_configuration !== true || features.explicit_execution_state !== true) throw new CollaborationError('BACKGROUND_TASK_RECORDS_UNSUPPORTED', 'Running service does not support background task records', 409);
  }
  if (operation === 'list') {
    const query = new URLSearchParams(); if (o.group) query.set('group', String(o.group)); if (o.purpose) query.set('purpose', String(o.purpose));
    return request('GET', `/tasks${query.size ? `?${query}` : ''}`);
  }
  if (operation === 'get') return request('GET', `/tasks/${encodeURIComponent(command.target!)}`);
  const contentSources = [o.content, o.file, o.stdin].filter(Boolean).length;
  if (contentSources > 1) throw new Error('Choose --content, --file or --stdin');
  const content = o.file ? fs.readFileSync(String(o.file), 'utf8') : o.stdin ? await io.stdin?.() : o.content;
  if (!['configure', 'assign', 'close', 'reopen', 'request-review', 'pause', 'resume', 'retry'].includes(operation) && (typeof content !== 'string' || !content.trim())) throw new Error('This task operation requires --content, --file or --stdin');
  const idempotencyKey = String(o['idempotency-key'] ?? randomUUID());
  const expectedRevision = o.revision === undefined ? undefined : Number(o.revision);
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new Error('--revision must be a positive integer');
  if (['configure', 'assign', 'revise', 'close', 'reopen', 'request-review', 'coordinate', 'pause', 'resume', 'retry'].includes(operation) && expectedRevision === undefined) throw new Error('Read task get first, then supply --revision to avoid overwriting another decision');
  if (['assign', 'request-review'].includes(operation) && !o.assignee) throw new Error('This task operation requires --assignee');
  if (['report', 'respond', 'ask', 'plan'].includes(operation) && !o.attempt) throw new Error('Use --attempt from the dispatch message; never guess the current attempt');
  if (operation === 'respond' && !o['to-event']) throw new Error('respond requires --to-event <comment-event-id>');
  if (operation === 'answer' && !o.decision) throw new Error('answer requires --decision <question-id>');
  if (operation === 'create') {
    if (!o.title || !o.group) throw new Error('task create requires --title and --group');
    return request('POST', '/tasks', { input: { idempotencyKey, groupId: o.group, title: o.title, spec: content,
      purpose: o.purpose, constraints: o.constraints, acceptance: o.acceptance, assigneeSessionId: o.assignee, coordinatorSessionId: o.coordinator,
      parentTaskId: o.parent, dependsOn: o['depends-on'] ? String(o['depends-on']).split(',').filter(Boolean) : undefined,
      integration: o.integration === true, managed: o.managed === true, isolated: o['shared-directory'] !== true, workType: o['work-type'],
      reviewerSessionIds: o.reviewers ? String(o.reviewers).split(',').filter(Boolean) : undefined } });
  }
  const options = o.options ? JSON.parse(String(o.options)) : undefined;
  if (options !== undefined && (!Array.isArray(options) || options.some(v => typeof v !== 'string'))) throw new Error('--options must be a JSON array of strings');
  return request('POST', `/tasks/${encodeURIComponent(command.target!)}`, { input: {
    purpose: o.purpose, replyToEventId: o['to-event'], decisionId: o.decision, kind: operation === 'plan' ? 'submit-plan' : operation, idempotencyKey, expectedRevision, content,
    assigneeSessionId: o.assignee, attemptId: o.attempt, status: o.status, artifactId: o.artifact, options, verdict: o.verdict,
    evidence: o.evidence ? JSON.parse(String(o.evidence)) : undefined, summary: o.summary,
  } });
}
