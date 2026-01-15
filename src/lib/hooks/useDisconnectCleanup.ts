import { useEffect, useRef, useCallback } from 'react';
import { useCleanupDuration } from './useCleanupDuration';
import type { PersistedTab } from './useSessionPersistence';

// 断联清理检测回调类型
export type OnDisconnectCleanupCallback = (staleTabs: PersistedTab[]) => void;

// 默认的清理检测间隔（毫秒）
const DEFAULT_CHECK_INTERVAL = 30000; // 30秒检查一次

interface UseDisconnectCleanupOptions {
  // 清理检测间隔（毫秒）
  checkIntervalMs?: number;
  // 断联清理回调函数
  onCleanup?: OnDisconnectCleanupCallback;
  // 是否启用自动清理
  enabled?: boolean;
}

interface UseDisconnectCleanupReturn {
  // 手动触发清理检查
  triggerCleanupCheck: () => void;
  // 注册一个会话为活跃状态
  markTabActive: (tabId: string) => void;
  // 获取当前活跃的会话数量
  getActiveTabCount: () => number;
}

/**
 * 断联清理 Hook
 * 
 * 此 Hook 负责监控会话的活跃状态，并在超过设置的清理时长后自动清理断联的会话。
 * 它使用心跳机制来跟踪会话的活跃状态，并在后台定期检查需要清理的会话。
 * 
 * @param options - 配置选项
 * @returns 清理控制函数
 */
export function useDisconnectCleanup(
  tabs: PersistedTab[],
  options: UseDisconnectCleanupOptions = {}
): UseDisconnectCleanupReturn {
  const {
    checkIntervalMs = DEFAULT_CHECK_INTERVAL,
    onCleanup,
    enabled = true,
  } = options;

  // 获取清理时长设置
  const { getEffectiveDuration } = useCleanupDuration();

  // 活跃会话的心跳记录
  const activeTabsRef = useRef<Map<string, number>>(new Map());
  // 定时器引用
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  // 最后一次有效时长（用于检测设置变化）
  const lastDurationRef = useRef<number>(getEffectiveDuration());

  // 注册会话为活跃状态
  const markTabActive = useCallback((tabId: string) => {
    if (!enabled) return;
    activeTabsRef.current.set(tabId, Date.now());
  }, [enabled]);

  // 手动触发清理检查
  const triggerCleanupCheck = useCallback(() => {
    if (!enabled || tabs.length === 0) return;

    const now = Date.now();
    const effectiveDuration = getEffectiveDuration();
    const staleTabs: PersistedTab[] = [];

    // 检查每个会话是否超过清理时长
    for (const tab of tabs) {
      const lastActivity = activeTabsRef.current.get(tab.tabId);
      
      // 如果没有心跳记录，使用持久化的 lastActivity
      const activityTime = lastActivity ?? tab.lastActivity;
      
      // 如果设置了永不清理，跳过检查
      if (effectiveDuration === Infinity) continue;

      // 如果会话超过清理时长，添加到待清理列表
      if (now - activityTime > effectiveDuration) {
        staleTabs.push(tab);
      }
    }

    // 如果有待清理的会话，调用回调函数
    if (staleTabs.length > 0 && onCleanup) {
      console.log(`[DisconnectCleanup] Found ${staleTabs.length} stale tabs to cleanup`);
      onCleanup(staleTabs);
    }
  }, [enabled, tabs, getEffectiveDuration, onCleanup]);

  // 设置定时器定期检查
  useEffect(() => {
    if (!enabled) return;

    // 创建定时器
    intervalRef.current = setInterval(() => {
      triggerCleanupCheck();
    }, checkIntervalMs);

    // 清理函数
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, checkIntervalMs, triggerCleanupCheck]);

  // 监听清理时长设置变化
  useEffect(() => {
    const currentDuration = getEffectiveDuration();
    
    // 如果设置发生变化，重新检查所有会话
    if (currentDuration !== lastDurationRef.current) {
      console.log(`[DisconnectCleanup] Cleanup duration changed from ${lastDurationRef.current}ms to ${currentDuration}ms`);
      lastDurationRef.current = currentDuration;
      
      // 如果新的设置为永不清理，取消所有待清理的会话
      if (currentDuration === Infinity) {
        activeTabsRef.current.clear();
      } else {
        // 重新检查所有会话
        triggerCleanupCheck();
      }
    }
  }, [getEffectiveDuration, triggerCleanupCheck]);

  // 获取当前活跃的会话数量
  const getActiveTabCount = useCallback(() => {
    return activeTabsRef.current.size;
  }, []);

  return {
    triggerCleanupCheck,
    markTabActive,
    getActiveTabCount,
  };
}

/**
 * 批量更新会话活跃状态
 * 
 * @param tabs 当前所有会话列表
 * @param activeTabId 当前活跃的会话 ID
 * @returns 需要标记为活跃的会话 ID 列表
 */
export function getTabsToMarkActive(
  tabs: PersistedTab[],
  activeTabId: string | null
): string[] {
  const now = Date.now();
  const recentThreshold = 5 * 60 * 1000; // 5分钟内有活动的会话被认为是活跃的

  return tabs
    .filter(tab => {
      // 当前活跃的会话总是需要标记
      if (tab.tabId === activeTabId) return true;
      
      // 5分钟内有活动的会话也认为是活跃的
      if (now - tab.lastActivity < recentThreshold) return true;
      
      return false;
    })
    .map(tab => tab.tabId);
}
