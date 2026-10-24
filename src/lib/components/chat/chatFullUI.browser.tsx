import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '../../../index.css';
import { I18nProvider } from '../../i18n';
import { ChatFullContent } from './ChatFullContent';
import type { ChatMessage } from './chatMessages';
let root: Root | undefined;
afterEach(() => { root?.unmount(); root = undefined; vi.unstubAllGlobals(); sessionStorage.clear(); document.body.replaceChildren(); document.documentElement.removeAttribute('style'); });
const code = `$open = false
root = Stack([Tabs([TabItem("form", "填写", [form]), TabItem("chart", "数据", [PieChart(["A", "B"], [2, 3], "donut"), Table([Col("方案", ["A", "B"]), Col("数值", [2, 3], "number")])])]), Button("打开弹窗", @Set($open, true)), Modal("确认信息", $open, [TextContent("可以在弹窗中继续操作。")])])
form = Form("details", Buttons([Button("提交选择", @ToAssistant("采用填写结果"))]), [FormControl("备注", Input("notes", "补充备注", "text", {required:true})), FormControl("模式", Select("mode", [SelectItem("a", "方案A"), SelectItem("b", "方案B")], "选择模式")), FormControl("出行日期", DatePicker("dates", "range")), FormControl("数量", Slider("count", "discrete", 0, 10, 1, [3], "数量"))])`;
for (const layout of [
  { name: 'portrait', width: 390, height: 844, top: 59, bottom: 34, left: 0, right: 0 },
  { name: 'landscape', width: 844, height: 390, top: 0, bottom: 21, left: 59, right: 59 },
  { name: 'desktop', width: 1280, height: 900, top: 38, bottom: 0, left: 0, right: 0 },
]) {
  it(`renders the full library, accepts inputs and keeps nested dialogs within ${layout.name} safe areas`, async () => {
    await page.viewport(layout.width, layout.height);
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) document.documentElement.style.setProperty(`--safe-${edge}-inset`, `${layout[edge]}px`);
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => { const body = init?.body ? JSON.parse(String(init.body)) : {}; return Response.json({ revision: Number(body.revision || 0) + 1, values: body.values || {} }); }));
    const message: ChatMessage = { id: 'full-browser', role: 'assistant', content: '选择和数据', createdAt: 1, status: 'stored', ui: { version: 2, code } };
    const host = document.createElement('div'); host.id = 'root'; document.body.append(host);
    root = createRoot(host); root.render(<I18nProvider><div className="h-full overflow-auto px-4"><ChatFullContent message={message} sessionId="full-browser" canWrite onAction={async () => true} /></div></I18nProvider>);
    await page.getByRole('tab', { name: '填写' }).click();
    await expect.element(page.getByPlaceholder('补充备注')).toBeVisible();
    await page.getByPlaceholder('补充备注').fill('希望内容完整');
    await page.getByLabelText('开始日期').fill('2026-11-01'); await page.getByLabelText('结束日期').fill('2026-11-03');
    await page.getByRole('combobox').filter({ hasText: '选择模式' }).click();
    await expect.element(page.getByRole('option', { name: '方案B' })).toBeVisible();
    await expect.poll(() => {
      const box = document.querySelector('[role="listbox"]')?.getBoundingClientRect();
      return !!box && box.left >= layout.left && box.right <= layout.width - layout.right + 1 && box.top >= layout.top && box.bottom <= layout.height - layout.bottom + 1;
    }).toBe(true);
    const menu = document.querySelector('[role="listbox"]')!.getBoundingClientRect();
    expect(menu.left).toBeGreaterThanOrEqual(layout.left); expect(menu.right).toBeLessThanOrEqual(layout.width - layout.right + 1);
    expect(menu.top).toBeGreaterThanOrEqual(layout.top); expect(menu.bottom).toBeLessThanOrEqual(layout.height - layout.bottom + 1);
    await page.getByRole('option', { name: '方案B' }).click();
    await expect.element(page.getByRole('combobox').filter({ hasText: '方案B' })).toHaveTextContent('方案B');
    await page.getByRole('tab', { name: '数据' }).click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await expect.element(page.getByRole('columnheader', { name: '数值' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    await page.getByRole('button', { name: '打开弹窗' }).click();
    await expect.element(page.getByRole('dialog', { name: '确认信息' })).toBeVisible();
    const dialog = document.querySelector('[role="dialog"][aria-label="确认信息"]')!.getBoundingClientRect();
    expect(dialog.left).toBeGreaterThanOrEqual(layout.left); expect(dialog.top).toBeGreaterThanOrEqual(layout.top);
    expect(dialog.right).toBeLessThanOrEqual(layout.width - layout.right + 1); expect(dialog.bottom).toBeLessThanOrEqual(layout.height - layout.bottom + 1);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect.element(page.getByRole('dialog', { name: '确认信息' })).not.toBeInTheDocument();
  });
}
