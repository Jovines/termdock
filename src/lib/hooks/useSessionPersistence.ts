import { useState, useEffect, useCallback, useRef } from 'react';

const STORAGE_KEY = 'web-terminal-sessions';

export interface PersistedTab {
  tabId: string;
  cwd: string;
  name: string;
  sessionId: string | null;  // 后端 sessionId，用于复用
  createdAt: number;
  lastActivity: number;
}

interface UseSessionPersistenceReturn {
  tabs: PersistedTab[];
  activeTabId: string | null;
  isLoading: boolean;
  saveTab: (tab: Omit<PersistedTab, 'createdAt' | 'lastActivity' | 'sessionId'>, sessionId: string | null) => void;
  removeTab: (tabId: string) => void;
  updateTabActivity: (tabId: string) => void;
  setActiveTab: (tabId: string | null) => void;
  updateTabSessionId: (tabId: string, sessionId: string) => void;
  clearAllTabs: () => void;
  restoreTabs: () => Promise<PersistedTab[]>;
}

export function useSessionPersistence(): UseSessionPersistenceReturn {
  const [tabs, setTabs] = useState<PersistedTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  // 从 localStorage 读取标签页
  const restoreTabs = useCallback(async (): Promise<PersistedTab[]> => {
    if (typeof window === 'undefined') return [];

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        const tabList = data.tabs || [];
        const activeId = data.activeTabId || null;

        setTabs(tabList);
        setActiveTabIdState(activeId);
        return tabList;
      }
    } catch (error) {
      console.error('Failed to restore tabs from localStorage:', error);
    } finally {
      setIsLoading(false);
    }

    return [];
  }, []);

  // 保存标签页到 localStorage
  const persistTabs = useCallback((tabList: PersistedTab[], activeId: string | null) => {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tabs: tabList,
        activeTabId: activeId,
      }));
    } catch (error) {
      console.error('Failed to persist tabs to localStorage:', error);
    }
  }, []);

  // 保存新标签页
  const saveTab = useCallback((tab: Omit<PersistedTab, 'createdAt' | 'lastActivity' | 'sessionId'>, sessionId: string | null) => {
    const now = Date.now();
    const newTab: PersistedTab = {
      ...tab,
      sessionId,
      createdAt: now,
      lastActivity: now,
    };

    setTabs(prev => {
      const updated = [...prev, newTab];
      persistTabs(updated, tab.tabId);
      return updated;
    });

    setActiveTabIdState(tab.tabId);
  }, [persistTabs]);

  // 移除标签页
  const removeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const updated = prev.filter(tab => tab.tabId !== tabId);
      const newActiveId = updated.length > 0 ? updated[0].tabId : null;
      persistTabs(updated, newActiveId);
      return updated;
    });
  }, [persistTabs]);

  // 更新标签页活跃时间
  const updateTabActivity = useCallback((tabId: string) => {
    const now = Date.now();
    setTabs(prev => {
      const updated = prev.map(tab =>
        tab.tabId === tabId ? { ...tab, lastActivity: now } : tab
      );
      // 保持当前的 activeTabId 不变
      const currentActive = prev.find(tab => tab.tabId === activeTabId);
      const newActiveId = currentActive ? currentActive.tabId : (updated[0]?.tabId || null);
      persistTabs(updated, newActiveId);
      return updated;
    });
  }, [activeTabId, persistTabs]);

  // 设置活跃标签页
  const setActiveTab = useCallback((tabId: string | null) => {
    setActiveTabIdState(tabId);
    setTabs(prev => {
      persistTabs(prev, tabId);
      return prev;
    });
  }, [persistTabs]);

  // 清除所有标签页
  const clearAllTabs = useCallback(() => {
    setTabs([]);
    setActiveTabIdState(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // 更新标签页的 sessionId
  const updateTabSessionId = useCallback((tabId: string, sessionId: string) => {
    setTabs(prev => {
      const updated = prev.map(tab =>
        tab.tabId === tabId ? { ...tab, sessionId } : tab
      );
      // 保持当前的 activeTabId 不变
      const currentActive = prev.find(tab => tab.tabId === activeTabId);
      const newActiveId = currentActive ? currentActive.tabId : (updated[0]?.tabId || null);
      persistTabs(updated, newActiveId);
      return updated;
    });
  }, [activeTabId, persistTabs]);

  // 初始化时恢复标签页
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      restoreTabs();
    }
  }, [restoreTabs]);

  return {
    tabs,
    activeTabId,
    isLoading,
    saveTab,
    removeTab,
    updateTabActivity,
    setActiveTab,
    updateTabSessionId,
    clearAllTabs,
    restoreTabs,
  };
}


