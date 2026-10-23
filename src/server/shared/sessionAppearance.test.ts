import { expect, it } from 'vitest';
import { validSessionAppearances, validSessionIcon } from './sessionAppearance';
it('accepts bounded icons and emoji while rejecting URLs, markup and arbitrary text', () => {
  for (const icon of ['rocket', '🎙️', '🚀', '👩🏽‍💻', '🇨🇳']) expect(validSessionIcon(icon)).toBe(true);
  for (const icon of ['https://example.com/icon.svg', '<img>', 'hello', '🚀🚀', '']) expect(validSessionIcon(icon)).toBe(false);
  expect(validSessionAppearances({ one: { name: '研究工作台', icon: '🎙️' } }, { kind: 'sessions', sessionIds: ['one'] })).toBe(true);
  for (const appearance of [{ other: { name: '越界' } }, { one: { name: 'a\nB' } }, { one: { name: ' ', icon: 'rocket' } }, { one: { name: 'x', actions: ['service:*'] } }]) expect(validSessionAppearances(appearance, { kind: 'sessions', sessionIds: ['one'] })).toBe(false);
  expect(validSessionAppearances({ one: { name: 'x' } }, { kind: 'service' })).toBe(false);
});
