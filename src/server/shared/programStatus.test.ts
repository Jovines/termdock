import { describe, expect, it } from 'vitest';
import { parseProgramStatus, ProgramStatusTracker } from './programStatus.js';

const osc = (body: string) => `\x1b]7501;${body}\x1b\\`;
const encoded = (text: string) => Buffer.from(text).toString('base64');

describe('native program reports', () => {
  it('negotiates support and tracks explicitly reported work, blocks, and completion across output chunks', () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed(osc('?'))).toMatchObject({ query: true, changed: false, progress: null });
    const report = osc(`state=working:app=codex:msg=${encoded('正在处理')}`);
    let result;
    for (const char of report) result = tracker.feed(char);
    expect(result).toMatchObject({ progress: { state: 'indeterminate', source: 'osc7501', app: 'codex', message: '正在处理' } });
    expect(tracker.feed(osc('state=blocked:kind=permission:progress=25'))).toMatchObject({ progress: { state: 'blocked', kind: 'permission', progress: 25 } });
    expect(tracker.feed(osc('state=done'))).toMatchObject({ progress: { state: 'done', progress: null } });
    expect(tracker.exit()).toMatchObject({ changed: false, progress: { state: 'done' } });
    expect(tracker.feed(osc('state=idle'))).toMatchObject({ progress: null });
  });

  it('prioritizes blocked children, inherits app identity, clears only the addressed subtree, and preserves errors at the shell prompt', () => {
    const tracker = new ProgramStatusTracker();
    tracker.feed(osc('state=working:app=build'));
    tracker.feed(osc('state=error:id=test'));
    expect(tracker.feed(osc('state=blocked:id=deploy/eu:kind=auth'))).toMatchObject({ progress: { app: 'build', state: 'blocked', kind: 'auth' } });
    expect(tracker.feed(osc('state=clear:id=deploy'))).toMatchObject({ progress: { state: 'error' } });
    expect(tracker.feed('\x1b]133;A\x07')).toMatchObject({ progress: { state: 'error', app: undefined } });
    expect(tracker.feed(osc('state=clear'))).toMatchObject({ progress: null });
  });

  it('handles legacy progress in stream order and lets native reports own progress until a full reset', () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed('\x1b]9;4;3;0\x07')).toMatchObject({ progress: { state: 'indeterminate' } });
    expect(tracker.feed('\x1b]133;A\x07')).toMatchObject({ progress: null });
    tracker.feed(osc('state=blocked'));
    expect(tracker.feed('\x1b]9;4;1;10\x07')).toMatchObject({ changed: false, progress: { state: 'blocked' } });
    expect(tracker.exit()).toMatchObject({ progress: null });
    expect(tracker.feed('\x1bc\x1b]9;4;1;50\x07')).toMatchObject({ progress: { state: 'set', progress: 50 } });
    expect(tracker.feed('\x1b]9;4;0\x07')).toMatchObject({ progress: null });
  });

  it.each([
    'state=unknown', 'id=child', 'state=working:id=invalid//child', 'state=clear:id=bad//id',
    `state=working:msg=${encoded('bad\nmessage')}`, `state=working:title=${encoded('\x1b[2J')}`,
    'state=working:msg=A', 'state=working:msg=Zg=', `state=working:msg=${'YQ'.repeat(1400)}`,
    `state=working:id=${'a'.repeat(33)}`, `state=working:${'x'.repeat(4096)}`,
  ])('rejects invalid reports without replacing a current status: %s', body => {
    const tracker = new ProgramStatusTracker(); tracker.feed(osc('state=blocked'));
    expect(parseProgramStatus(body)).toBeNull();
    expect(tracker.feed(osc(body))).toMatchObject({ changed: false, progress: { state: 'blocked' } });
  });

  it('ignores unknown keys, applies the last repeated value, strips invisible formatting, and replaces record fields', () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed(osc(`future=anything:state=idle:state=working:app=codex:msg=${encoded('a\u202eb')}`))).toMatchObject({ progress: { message: 'ab', app: 'codex' } });
    expect(tracker.feed(osc('state=working:progress=101'))).toMatchObject({ progress: { state: 'indeterminate', app: undefined, message: undefined } });
    expect(tracker.feed(osc('state=working:progress=20'))).toMatchObject({ progress: { state: 'set', progress: 20 } });
  });
});
