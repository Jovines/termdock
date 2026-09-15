import { afterEach, expect, it } from 'vitest';
import { useSessionNoticeStore as store } from './useSessionNoticeStore';
afterEach(() => store.setState({ unread: {}, viewing: null }));
it('counts unique notices independently per session and only clears the viewed session', () => {
  store.getState().receive('one', 'n1');
  store.getState().receive('one', 'n1');
  store.getState().receive('one', 'n2');
  store.getState().receive('two', 'n3');
  expect(store.getState().unread).toEqual({ one: ['n1', 'n2'], two: ['n3'] });
  store.getState().view('one');
  store.getState().receive('one', 'n4');
  expect(store.getState().unread).toEqual({ two: ['n3'] });
  store.getState().view(null);
  store.getState().receive('one', 'n5');
  expect(store.getState().unread).toEqual({ one: ['n5'], two: ['n3'] });
});
