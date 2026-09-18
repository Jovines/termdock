import { describe, expect, it } from 'vitest';
import {
  classifyChildExit,
  isReadyMessage,
  isServerIntentMessage,
  shouldGiveUp,
  type ExitObservation,
} from './supervisorProtocol.js';

function observation(overrides: Partial<ExitObservation> = {}): ExitObservation {
  return {
    intent: null,
    exitCode: null,
    signal: null,
    becameReady: true,
    supervisorStopRequested: false,
    restartRequested: false,
    wedge: false,
    portConflict: false,
    oomSuspect: false,
    ...overrides,
  };
}

describe('classifyChildExit', () => {
  it('supervisor 收到停止信号 → 停止且不重启', () => {
    const decision = classifyChildExit(observation({
      supervisorStopRequested: true,
      signal: 'SIGTERM',
    }));
    expect(decision.event).toBe('stop');
    expect(decision.restart).toBe(false);
  });

  it('服务自己声明 stop intent → 停止且不重启', () => {
    const decision = classifyChildExit(observation({ intent: 'stop', exitCode: 0 }));
    expect(decision.event).toBe('stop');
    expect(decision.restart).toBe(false);
  });

  it('停止优先于崩溃判定：stop 请求 + 非零退出码仍然是 stop', () => {
    const decision = classifyChildExit(observation({
      supervisorStopRequested: true,
      exitCode: 1,
      signal: null,
    }));
    expect(decision.event).toBe('stop');
    expect(decision.countAsCrash).toBe(false);
  });

  it('卡死判定优先于信号：被自己 SIGKILL 的 wedge 必须重启', () => {
    const decision = classifyChildExit(observation({ wedge: true, signal: 'SIGKILL' }));
    expect(decision.event).toBe('wedge');
    expect(decision.restart).toBe(true);
    expect(decision.countAsCrash).toBe(true);
  });

  it('更新重启即使拿到 SIGTERM 也照常重启，且不计入崩溃、退避归零', () => {
    const decision = classifyChildExit(observation({
      intent: 'restart-after-update',
      signal: 'SIGTERM',
    }));
    expect(decision.event).toBe('update-restart');
    expect(decision.restart).toBe(true);
    expect(decision.countAsCrash).toBe(false);
    expect(decision.resetBackoff).toBe(true);
  });

  it('更新重启退出码为 0 也不被当成 exit-zero-unexpected', () => {
    const decision = classifyChildExit(observation({
      intent: 'restart-after-update',
      exitCode: 0,
    }));
    expect(decision.event).toBe('update-restart');
  });

  it('td --restart（SIGHUP）：记成 manual-restart 而不是更新重启', () => {
    const decision = classifyChildExit(observation({ restartRequested: true, signal: 'SIGTERM' }));
    expect(decision.event).toBe('manual-restart');
    expect(decision.restart).toBe(true);
    expect(decision.countAsCrash).toBe(false);
    expect(decision.resetBackoff).toBe(true);
  });

  it('更新重启优先于手动重启：两者的意图都成立时按更新记账', () => {
    const decision = classifyChildExit(observation({
      intent: 'restart-after-update',
      restartRequested: true,
    }));
    expect(decision.event).toBe('update-restart');
  });

  it('停止优先于手动重启：先收到 --stop 就不该再重启', () => {
    const decision = classifyChildExit(observation({
      supervisorStopRequested: true,
      restartRequested: true,
    }));
    expect(decision.event).toBe('stop');
    expect(decision.restart).toBe(false);
  });

  it('端口冲突优先于"未就绪"，给出可辨认的原因', () => {
    const decision = classifyChildExit(observation({
      portConflict: true,
      becameReady: false,
      exitCode: 1,
    }));
    expect(decision.event).toBe('port-conflict');
    expect(decision.restart).toBe(true);
  });

  it('从未就绪 → startup-failure（含退出码细节）', () => {
    const decision = classifyChildExit(observation({
      becameReady: false,
      exitCode: 1,
    }));
    expect(decision.event).toBe('startup-failure');
    expect(decision.detail).toContain('exit code 1');
    expect(decision.restart).toBe(true);
    expect(decision.countAsCrash).toBe(true);
  });

  it('外部 SIGTERM（无 intent）= 有意停机，只记录不重启', () => {
    const decision = classifyChildExit(observation({ signal: 'SIGTERM' }));
    expect(decision.event).toBe('terminated-externally');
    expect(decision.restart).toBe(false);
    expect(decision.countAsCrash).toBe(false);
  });

  it('外部 SIGINT 同样视为有意停机', () => {
    expect(classifyChildExit(observation({ signal: 'SIGINT' })).event).toBe('terminated-externally');
  });

  it('SIGKILL → killed，重启并计数', () => {
    const decision = classifyChildExit(observation({ signal: 'SIGKILL' }));
    expect(decision.event).toBe('killed');
    expect(decision.restart).toBe(true);
    expect(decision.countAsCrash).toBe(true);
  });

  it('原生崩溃信号 → crash-native', () => {
    for (const signal of ['SIGSEGV', 'SIGABRT', 'SIGBUS'] as const) {
      expect(classifyChildExit(observation({ signal })).event).toBe('crash-native');
    }
  });

  it('其它信号归入 crash', () => {
    expect(classifyChildExit(observation({ signal: 'SIGHUP' })).event).toBe('crash');
  });

  it('曾就绪但带 0 退出码 → exit-zero-unexpected（同样要重启）', () => {
    const decision = classifyChildExit(observation({ exitCode: 0 }));
    expect(decision.event).toBe('exit-zero-unexpected');
    expect(decision.restart).toBe(true);
    expect(decision.countAsCrash).toBe(true);
  });

  it('普通非零退出 → crash', () => {
    const decision = classifyChildExit(observation({ exitCode: 7 }));
    expect(decision.event).toBe('crash');
    expect(decision.detail).toBe('exit code 7');
  });

  it('退出码与信号都缺失时仍能分类，不会漏判成"正常"', () => {
    const decision = classifyChildExit(observation({ becameReady: true }));
    expect(decision.restart).toBe(true);
    expect(decision.detail).toBe('unknown termination');
  });

  it('有意为之的退出（重启/停机）重置退避，意外退出不重置', () => {
    const resetting = [
      classifyChildExit(observation({ intent: 'restart-after-update' })),
      classifyChildExit(observation({ restartRequested: true })),
      classifyChildExit(observation({ intent: 'stop' })),
      classifyChildExit(observation({ supervisorStopRequested: true })),
      classifyChildExit(observation({ signal: 'SIGTERM' })),
    ];
    expect(resetting.every((decision) => decision.resetBackoff)).toBe(true);
    expect(classifyChildExit(observation({ exitCode: 1 })).resetBackoff).toBe(false);
    expect(classifyChildExit(observation({ signal: 'SIGKILL' })).resetBackoff).toBe(false);
  });
});

describe('shouldGiveUp', () => {
  it('默认 5 次连续崩溃后放弃', () => {
    expect(shouldGiveUp(4)).toBe(false);
    expect(shouldGiveUp(5)).toBe(true);
    expect(shouldGiveUp(9)).toBe(true);
  });

  it('阈值可覆盖', () => {
    expect(shouldGiveUp(2, 3)).toBe(false);
    expect(shouldGiveUp(3, 3)).toBe(true);
  });
});

describe('消息判别', () => {
  it('识别 ready 消息', () => {
    expect(isReadyMessage({ type: 'termdock-ready' })).toBe(true);
    expect(isReadyMessage({ type: 'termdock-intent' })).toBe(false);
    expect(isReadyMessage(null)).toBe(false);
  });

  it('识别 intent 消息，拒绝未知 intent', () => {
    expect(isServerIntentMessage({ type: 'termdock-intent', intent: 'stop' })).toBe(true);
    expect(isServerIntentMessage({ type: 'termdock-intent', intent: 'restart-after-update' })).toBe(true);
    expect(isServerIntentMessage({ type: 'termdock-intent', intent: 'nonsense' })).toBe(false);
    expect(isServerIntentMessage({ type: 'termdock-ready' })).toBe(false);
    expect(isServerIntentMessage(undefined)).toBe(false);
  });
});
