export const NOTIFY_PROMPT = `在本任务中使用 TD 提醒我：
1. 先运行 td n 查看用法。
2. 完成关键里程碑、遇到阻塞、需要我决策或任务完成时，运行 td n "简短进展；需要我做什么"。
3. 在当前 Termdock 会话内执行，来源会话会自动识别；不要猜测其他 Session 的 ID。
4. 日常过程日志不用提醒，同一进展不要重复发送。正常工作继续进行，不要为发送提醒另行请求确认。
5. 检查命令的 JSON 回执与退出码：成功只表示已向在线连接转发，不代表我已阅读。
6. 若没有在线连接、无法识别会话或服务不可用，在对话里说明未送达；不要反复重试或声称已送达。
7. 提醒不会替代最终回复，也不会自动安装全局规则或改变其他任务的行为。`;

export const NOTIFY_HELP = `TD 进展提醒 / Progress reminders

最短用法：td n "测试通过，可以验收"
完整用法 / Usage: td notify <message> [--title <title>] [--session <full-session-id>]

  td n                    查看帮助和 Agent 使用提示（不会发送提醒）
  td n "关键进展"          发到在线 TD 页面，点击卡片返回来源 Session
  td n --prompt           输出可复制给 Agent 的提示词
  td n --help             同上方帮助；td notify 与 td n 完全等价

你可以直接对 Agent 说：用 td n 提醒我，先运行 td n 看用法。

示例：
  td n "实现完成，正在构建"
  td n "两种方案需要你选择，请回到此会话确认" --title "需要决策"
  td n "后台任务完成" --session <自己的完整Session-ID>

正文是一个加引号的参数，最多 4000 字符；标题可选，最多 120 字符。
默认从当前终端/tmux pane 自动识别来源。脱离终端的后台进程才需要 --session。
卡片 8 秒后收起；未读标记保留到打开对应 Session。关闭卡片不会清除未读。
没有在线页面时不离线保存。退出码 0 表示已转发，非零表示失败；JSON 回执不是已读确认。

给 Agent 的提示词：
${NOTIFY_PROMPT}`;

export interface NotifyCommand { message: string; title?: string; session?: string; help?: boolean; prompt?: boolean }
export function parseNotifyCommand(args: string[]): NotifyCommand {
  if (args.length === 1 && args[0] === '--prompt') return { message: '', prompt: true };
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) return { message: '', help: true };
  const result: NotifyCommand = { message: '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--title' || arg === '--session') {
      const key = arg === '--title' ? 'title' : 'session';
      const value = args[++i]?.trim();
      if (!value || value.startsWith('--') || result[key]) throw new Error(`Invalid ${arg}`);
      result[key] = value;
    } else if (!arg.startsWith('-') && !result.message) result.message = arg.trim();
    else throw new Error('Pass one quoted message; see td notify --help');
  }
  validateNotifyContent(result);
  if (result.session && result.session.length > 128) throw new Error('Session ID is too long');
  return result;
}

export function validateNotifyContent(input: { message?: unknown; title?: unknown }): void {
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 4000) {
    throw new Error('Message must contain 1–4000 characters');
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120)) {
    throw new Error('Title must contain 1–120 characters');
  }
}
