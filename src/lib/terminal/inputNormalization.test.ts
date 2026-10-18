import {expect,it} from 'vitest';
import {sanitizeTerminalInput} from './inputNormalization';
import {terminalSequencePayload} from './sequencePayload';
it('retains legacy Unicode/zero-width/newline cleaning and one non-submitting bracketed block',()=>{
 const source='a\u00a0b\u2000c\u3000d\u200b\u200c\u200d\ufeff\r\ne\nf\r';
 const cleaned=sanitizeTerminalInput(source);expect(cleaned).toBe('a b c d\re\rf\r');
 expect(terminalSequencePayload(cleaned,{paste:true,submitAfterPaste:false})).toBe('\x1b[200~a b c d\re\rf\r\x1b[201~');expect(sanitizeTerminalInput('')).toBe('');expect(sanitizeTerminalInput('é中🙂')).toBe('é中🙂');
});
