import { describe, expect, it } from 'vitest';
import { collaborationResultPresentation as present } from './resultPresentation';

describe('result reading without inferred summaries', () => {
  it('shows the labelled conclusion and limits while preserving access to the complete original', () => {
    const body = '任务 abc（版本 def）通过评审。\n\n结论：CPU 25.6%，可用内存 40 GiB。\n\n证据：/tmp/raw.json\n\n限制：只代表 20 秒窗口。';
    expect(present(body)).toEqual({ summary: 'CPU 25.6%，可用内存 40 GiB。', limitations: '只代表 20 秒窗口。', condensed: true, explicit: false });
  });
  it('uses an explicit author summary and retains limitations from the report', () => {
    expect(present('完整数据\n\n限制：未覆盖移动端。', '已完成桌面适配。')).toMatchObject({ summary: '已完成桌面适配。', limitations: '未覆盖移动端。', explicit: true });
  });
  it('does not fabricate or truncate a summary for unstructured or ambiguous reports', () => {
    const body = '结论可能还要讨论，暂未交付。\n\n第二段仍然重要。';
    expect(present(body)).toMatchObject({ summary: body, limitations: '', condensed: false });
  });
  it('supports a Markdown heading followed by a conclusion paragraph', () => {
    expect(present('## 结论\n\n未发现当前持续换页。\n\n## 限制\n\n仅采样 20 秒。')).toMatchObject({ summary: '未发现当前持续换页。', limitations: '仅采样 20 秒。' });
  });
});
