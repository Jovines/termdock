import {it,expect} from 'vitest';
import {nativeMenuShortcut,nativeTerminalShortcut,nativeSessionFontShortcut} from './nativeShortcuts';
it('routes every application menu binding from the native focus through the same dispatcher',()=>{
 for(const [key,code,mods,id] of [['t',17,8,'new-session'],['w',13,8,'close-session'],[',',43,8,'settings'],['n',45,8,'new-connection'],['b',11,8,'toggle-left-sidebar'],['B',11,9,'toggle-right-sidebar'],['{',33,9,'previous-session'],['}',30,9,'next-session'],['[',33,12,'previous-attention'],[']',30,12,'next-attention'],['r',15,8,'reload'],['R',15,9,'force-reload'],['0',29,8,'reset-zoom'],['+',24,9,'zoom-in'],['-',27,8,'zoom-out'],['O',31,9,'connection-center']] as const)expect(nativeMenuShortcut(key,code,mods)).toBe(id);
 expect(nativeMenuShortcut('t',17,0)).toBeNull();expect(nativeMenuShortcut('b',11,12)).toBeNull();expect(nativeMenuShortcut('c',8,8)).toBeNull();
});

it('normalizes only exact legacy terminal chords and AppKit special key representations',()=>{
 for(const mods of [2,8,10,24])expect(nativeTerminalShortcut('K',40,mods)).toEqual({kind:'clear'});
 for(const [key,code,data] of [['\r',36,'\r'],['\x03',76,'\r'],['\x7f',51,'\x15'],['\uf728',117,'\x0b'],['\uf702',123,'\x01'],['\uf703',124,'\x05']] as const)expect(nativeTerminalShortcut(key,code,8)).toEqual({kind:'input',data});
 for(const mods of [0,1,3,4,5,6,7,9,11,12,13,14,15])expect(nativeTerminalShortcut('k',40,mods)).toBeNull();
 expect(nativeTerminalShortcut('unknown',12,8)).toBeNull();expect(nativeMenuShortcut('t',17,10)).toBeNull();
});

it('keeps both plus spellings, minus and reset in the focused session without stealing modified chords',()=>{
 expect(nativeSessionFontShortcut('+',9)).toBe('increase');
 expect(nativeSessionFontShortcut('=',8)).toBe('increase');
 expect(nativeSessionFontShortcut('=',9)).toBe('increase');
 expect(nativeSessionFontShortcut('-',8)).toBe('decrease');
 expect(nativeSessionFontShortcut('0',8)).toBe('reset');
 for(const mods of [0,1,2,3,4,5,6,7,10,11,12,13,14,15])for(const key of ['+','=','-','0'])expect(nativeSessionFontShortcut(key,mods)).toBeNull();
 expect(nativeSessionFontShortcut('-',9)).toBeNull();expect(nativeSessionFontShortcut('0',9)).toBeNull();
});
