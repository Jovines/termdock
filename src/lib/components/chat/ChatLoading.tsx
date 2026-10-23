import './sessionChat.css';
/** Match the conversation's geometry while code and history load in parallel. */
export function ChatLoading() {
  return <div data-chat-loading role="status" aria-label="正在加载对话" className="py-4">
    <div aria-hidden="true" className="space-y-6">
      <div className="chat-loading-skeleton ml-auto h-11 w-[48%] max-w-md rounded-2xl bg-surface-2" />
      <div className="space-y-3"><div className="chat-loading-skeleton h-4 w-20 rounded bg-surface-2" /><div className="chat-loading-skeleton h-3 w-[88%] rounded bg-surface-2" /><div className="chat-loading-skeleton h-3 w-[72%] rounded bg-surface-2" /><div className="chat-loading-skeleton h-3 w-[54%] rounded bg-surface-2" /></div>
      <div className="space-y-3"><div className="chat-loading-skeleton h-3 w-[80%] rounded bg-surface-2" /><div className="chat-loading-skeleton h-3 w-[62%] rounded bg-surface-2" /></div>
    </div>
  </div>;
}
