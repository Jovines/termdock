import { describe, expect, it, vi } from 'vitest';
import { XrdpLoginJournal } from './xrdpLogin.js';

const record = (pid: string, message: string, unit = 'xrdp.service') => JSON.stringify({ _SYSTEMD_UNIT: unit, _PID: pid, MESSAGE: message }) + '\n';
describe('local XRDP login observation', () => {
  it('matches the unique client and process before accepting a login result, including fragmented records', () => {
    const result = vi.fn(), journal = new XrdpLoginJournal('td-test', result);
    journal.receive(record('10', '[INFO ] login successful for user another'));
    journal.receive(record('20', '[INFO ] Connected client computer name: td-test', 'unrelated.service'));
    journal.receive(record('20', '[INFO ] login failed for user another'));
    expect(result).not.toHaveBeenCalled();
    const identity = record('30', '[INFO ] Connected client computer name: td-test');
    journal.receive(identity.slice(0, 40)); journal.receive(identity.slice(40));
    journal.receive(record('20', '[INFO ] login failed for user another'));
    expect(journal.matched).toBe(true); expect(result).not.toHaveBeenCalled();
    journal.receive(record('30', '[INFO ] login successful for user test on display 10'));
    journal.receive(record('30', '[INFO ] login failed for user test'));
    expect(result).toHaveBeenCalledExactlyOnceWith('authenticated');
  });
  it('reports rejected auto-login once and ignores malformed records and cancelled observers', () => {
    const result = vi.fn(), journal = new XrdpLoginJournal('td-test', result);
    journal.receive('invalid json\nnull\n');
    journal.receive(record('30', '[INFO ] Connected client computer name: td-test'));
    journal.receive(record('30', '[INFO ] xrdp_wm_log_msg: login failed for user test') + record('30', '[INFO ] login failed for user test'));
    expect(result).toHaveBeenCalledExactlyOnceWith('failed');
    const cancelled = new XrdpLoginJournal('td-test', result); cancelled.cancel();
    cancelled.receive(record('30', '[INFO ] Connected client computer name: td-test') + record('30', '[INFO ] login successful for user test'));
    expect(result).toHaveBeenCalledTimes(1);
  });
});
