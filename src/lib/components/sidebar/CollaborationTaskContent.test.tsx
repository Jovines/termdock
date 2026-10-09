// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CollaborationTaskContent from './CollaborationTaskContent';
afterEach(cleanup);
describe('task delivery reading', () => {
  it('renders headings, lists, emphasis and code with the existing Markdown reader', () => {
    const { container } = render(<CollaborationTaskContent content={'## 交付说明\n\n已保留 **终端输入**。\n\n- 图片可以重试\n- 窄屏可关闭\n\n```ts\nconst retry = true;\n```'} />);
    expect(screen.getByRole('heading', { name: '交付说明' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('终端输入');
    expect(container.querySelectorAll('li').length).toBe(2);
    expect(container.querySelector('pre')?.textContent).toContain('const retry = true;');
  });
  it('does not turn artifact content into active HTML or unsafe links', () => {
    const { container } = render(<CollaborationTaskContent content={'<script>window.taskInjected = true</script>\n\n[危险链接](javascript:alert(1))\n\n普通交付'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText('普通交付')).toBeTruthy();
  });
});
