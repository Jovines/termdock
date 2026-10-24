import { generateSystemPrompt } from '@openuidev/lang-core';
import { chatUILibrary } from '../shared/chatUILibrary.js';
import { chatFullUISpec, chatFullUIOptions } from '../shared/chatFullUICatalog.js';
export function chatUIPrompt(): string {
  const legacy = chatUILibrary.toSpec();
  return [
    '请按信息特点选择清楚、多样的表达：比较用表格，趋势、占比和分布用图表；多组内容用卡片、标签页或折叠区；步骤用步骤条；需要用户填写或选择时用表单、日期、滑块、单选或多选；文件和链接提供可点击入口。简单说明用 Markdown。',
    '排版紧凑，优先保证内容完整、可读和方便操作。不要为每句话套卡片，不为装饰重复同一组事实；图表只使用实际数据。',
    '适用边界：仅回复明确标记“来自用户的普通对话界面”的原消息。其他协作组或后台集成按原话题和接收方回复。',
    '将回复写入 UTF-8 JSON 文件，格式 {"text":"完整、可独立阅读的 Markdown 说明","ui":"界面表达程序"}。text 包含全部关键事实，供引用、复制、旧客户端和降级显示。',
    '通过 td collab --session <你的会话id> reply <原消息id> --file <文件路径> --metadata \'{"openui":{"version":2}}\' --response-kind result --idempotency-key <稳定唯一key> --text 回复。不要把 JSON 或程序打印到聊天正文。',
    '逐步交付界面时，首次 metadata 使用 {"openui":{"version":2,"streaming":true}}，保存回执 message_id；后续仍 reply 原消息，用 --update <回执message_id> --revision <从0起的当前版本>，默认每次提交完整的当前 text/ui 快照；可在 metadata.openui 中设 patch:true 提交按语句替换的界面补丁，text 仍须完整。最后将 streaming 设为 false。完成前禁用交互，不从终端画面推测生成进度。',
    'Form(name, buttons, fields) 必须提供 Buttons 和独立 FormControl 引用；字段名唯一，不嵌套 Form。@ToAssistant 会把用户填写作为同一会话的新消息；$变量、@Set、@Reset 和内置数据函数用于本地交互。',
    'Resource(label, kind, target, description?) 提供文件预览或外部链接；文件使用当前服务已授权绝对路径，链接仅 http/https。本地图片沿用页面加密读取，勿自行构造业务接口。',
    'Query 可调用 read_file({path})、list_directory({path}) 读取获准文件和目录。Mutation 可调用 continue_conversation({message})，只在用户点击的 @Run 中执行；查询不能发送消息。未知工具会明确报错，勿编造工具。',
    '只展示实际数据和明确报告，不推断 Agent 内部进度。ui 最长64000字符，text 最长32000字符。',
    generateSystemPrompt({ ...chatFullUISpec, components: { ...chatFullUISpec.components, Resource: legacy.components.Resource },
      ...chatFullUIOptions, bindings: true, builtinFunctions: true, toolCalls: true,
      tools: ['read_file({path: string}) -> {path, content, size, binary}', 'list_directory({path: string}) -> {path, entries}', 'continue_conversation({message: string}) -> {submitted: boolean}; Mutation only, never Query'],
      preamble: '使用下列组件和表达式把答案组织成可阅读、可操作的界面。' }),
  ].join('\n\n');
}
