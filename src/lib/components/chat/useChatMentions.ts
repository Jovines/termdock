import { useEffect, useMemo, useState } from 'react';
import { listCollaborationGroups, subscribeCollaborationGroups, type CollaborationGroup } from '../../terminal/api';
import { useSessionDirectory } from '../../stores/useSessionDirectory';
import type { ChatMention } from './chatComposerContent';

/** Group membership supplies scope; the reconciled Session directory supplies labels. */
export function useChatMentions(sessionId: string, enabled: boolean, open: boolean) {
  const directory = useSessionDirectory();
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !open) return;
    let alive = true;
    setStatus('loading');
    const update = (data: { groups: CollaborationGroup[] }) => { if (alive) { setGroups(data.groups); setStatus('ready'); } };
    const unsubscribe = subscribeCollaborationGroups(update);
    void listCollaborationGroups().then(update).catch(() => { if (alive) setStatus('error'); });
    return () => { alive = false; unsubscribe(); };
  }, [sessionId, enabled, open, version]);
  const members = useMemo(() => {
    const result: ChatMention[] = [];
    for (const group of groups) {
      if (group.archivedAt || !group.sessionIds.includes(sessionId)) continue;
      for (const id of group.sessionIds) {
        const member = directory.find(session => session.sessionId === id);
        if (id !== sessionId && member?.agent) result.push({ sessionId: id, groupId: group.id, groupName: group.name, name: member.displayName, ...(member.displaySubtitle ? { subtitle: member.displaySubtitle } : {}) });
      }
    }
    return result;
  }, [directory, groups, sessionId]);
  return { members, status, retry: () => setVersion(value => value + 1) };
}
