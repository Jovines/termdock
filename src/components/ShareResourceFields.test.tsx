// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ShareResourceFields, ShareResourceSummary } from './ShareResourceFields';
import { listAndroidDevices } from '../lib/android/api';
import type { ShareResources } from '../server/shared/shareResources';
vi.mock('../lib/android/api', () => ({ listAndroidDevices: vi.fn() }));
vi.mock('../lib/components/sidebar/FileTree', () => ({ FileTree: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows one phone, counts it once and grants/removes every verified address together', async () => {
  const phones = ['10.0.0.2:5555', '[fd00::2]:5555'].map(serial => ({ serial, state: 'device' as const, model: 'Pixel', physicalId: 'phone-a', isNetwork: true }));
  vi.mocked(listAndroidDevices).mockResolvedValue({ adbAvailable: true, scrcpyVersion: '4', devices: phones });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ preferences: {} })));
  let latest: ShareResources = {};
  function Fixture() { const [value, setValue] = useState<ShareResources>({}); latest = value; return <ShareResourceFields value={value} onChange={setValue} />; }
  const view = render(<Fixture />);
  const section = view.container.querySelector('details')!;
  fireEvent.click(section.querySelector('summary')!);
  const checkbox = await within(section).findByRole('checkbox'); expect(within(section).getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(checkbox); expect(screen.getByText('已选 1 台')).toBeTruthy(); expect(latest.android).toHaveLength(2);
  fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'control' } });
  expect(latest.android?.every(item => item.access === 'control')).toBe(true);
  const summary = render(<ShareResourceSummary resources={latest} />);
  await waitFor(() => expect(within(summary.container).getAllByRole('listitem')).toHaveLength(1));
  expect(within(summary.container).getByText('手机 · Pixel · 可操作')).toBeTruthy();
  act(() => fireEvent.click(checkbox)); expect(latest.android).toEqual([]);
});
