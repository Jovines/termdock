import { chatUILibrary } from '../shared/chatUILibrary.js';
export function chatUIPrompt(): string {
  return [
    'Termdock 普通对话支持 OpenUI。简单回复使用普通 Markdown；比较、数据、表单和文件入口优先使用结构化组件。',
    '排版以清楚、紧凑为先：Card 作为有标题的内容分节，不要为每句话或每个指标建立分节。相关 Metric 连续排列；表格直接放在对应分节下。Callout 只用于需要特别强调的信息，避免重复正文。不要为了装饰重复展示同一组事实。',
    '适用边界：仅回复明确标记“来自用户的普通对话界面”的原消息。其他协作组或后台集成的消息不会自动进入普通对话；按其原话题和原接收方回复，不要为它们套用此展示协议。',
    '将回复写入 UTF-8 JSON 文件，格式 {"text":"完整、可独立阅读的 Markdown 说明","ui":"OpenUI Lang 程序"}。text 必须包含全部关键事实，供引用、复制、旧客户端和降级显示。',
    '通过 td collab --session <你的会话id> reply <原消息id> --file <文件路径> --metadata \'{"openui":{"version":1}}\' --response-kind result --idempotency-key <稳定唯一key> --text 回复。不要把 JSON 或 OpenUI 程序直接打印到聊天正文。',
    '表单使用 Form + Input/Select/Checkbox + Button(@ToAssistant("用户可读的提交说明"))。用户提交会成为同一会话的新消息，附带填写内容。每个字段名称唯一；不要嵌套 Form。',
    'Resource 文件仅使用已授权绝对路径；链接仅使用 http/https。所有操作由用户明确点击，权限由服务端检查。禁止生成 Query/Mutation、脚本、任意 HTML 或自己调用业务接口。',
    '只展示原始数据和明确报告。Checklist 不代表推测的 Agent 忙闲或内部进度。ui 最长 64000 字符，text 最长 32000 字符。',
    chatUILibrary.prompt({ toolCalls: false, bindings: false, builtinFunctions: false, examples: ['root = Stack([summary, options])\nsummary = Card("比较结果", [Text("两种方案各有取舍。"), Table(["方案", "内存"], [["A", "4 GB"], ["B", "8 GB"]])])\noptions = Form("choice", "选择下一步", [Select("plan", "采用哪个方案", ["A", "B"], true), Input("notes", "补充要求"), Button("确认选择", @ToAssistant("采用所选方案，按补充要求继续"))])'] }),
  ].join('\n\n');
}
