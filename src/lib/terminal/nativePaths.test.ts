// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {activateNativePathHit,nativePathHoverRects} from './nativePaths';
const row=(text:string,wrapped=false,fgMode=0,fgColor=0)=>({wrapped,cells:[...text].map(chars=>({chars,width:1,fgMode,fgColor}))});
it('uses existing path semantics for normal, soft-wrap, colored hard-wrap, escaped spaces and line suffix',()=>{
 for(const data of [
  {rows:[row('/home/me/file.ts:7')],row:0,column:10},
  {rows:[row('/home/me/'),row('file.ts:7',true)],row:1,column:3},
  {rows:[row('/home/me/   ',false,1,2),row(' file.ts:7  ',false,1,2)],row:1,column:3},
 ]){const activate=vi.fn();expect(activateNativePathHit({version:1,...data},activate)).toBe(true);expect(activate).toHaveBeenCalledWith('/home/me/file.ts',7);}
 const activate=vi.fn();expect(activateNativePathHit({version:1,rows:[row('/home/a\\ b/file')],row:0,column:9},activate)).toBe(true);expect(activate).toHaveBeenCalledWith('/home/a\\ b/file');
});
it('wide and combining cells retain the clicked cell position',()=>{
 const cells=[{chars:'界',width:2,fgMode:0,fgColor:0},{chars:'',width:0,fgMode:0,fgColor:0},...row(' é /home/file').cells];const activate=vi.fn();expect(activateNativePathHit({version:1,row:0,column:10,rows:[{wrapped:false,cells}]},activate)).toBe(true);expect(activate).toHaveBeenCalledWith('/home/file');
});
it('URL matches, ordinary prose and corrupt/oversized engine slices remain inert',()=>{
 const activate=vi.fn();for(const data of [{version:1,rows:[row('https://example.test/path')],row:0,column:10},{version:1,rows:[row('ordinary prose')],row:0,column:3},{version:1,rows:[row('/path')],row:9,column:0},{version:1,rows:[row('/'.repeat(4097))],row:0,column:1}])expect(activateNativePathHit(data,activate)).toBe(false);expect(activate).not.toHaveBeenCalled();
});

it('plain clicks reuse WebLinksAddon URL matching, wide cells and soft wraps',()=>{
 const open=vi.fn(),path=vi.fn();
 for(const data of [
  {rows:[row('https://example.test/path?q=1')],row:0,column:12},
  {rows:[row('https://example.'),row('test/path?q=1',true)],row:1,column:5},
  {rows:[{wrapped:false,cells:[{chars:'中',width:2,fgMode:0,fgColor:0},{chars:'',width:0,fgMode:0,fgColor:0},...row(' https://example.test/path?q=1').cells]}],row:0,column:16},
 ])expect(activateNativePathHit({version:1,...data},path,open)).toBe(true);
 expect(open.mock.calls).toEqual(Array(3).fill(['https://example.test/path?q=1']));expect(path).not.toHaveBeenCalled();
 expect(activateNativePathHit({version:1,rows:[row('/home/me/file.ts:7')],row:0,column:8},path,open)).toBe(true);expect(path).toHaveBeenCalledWith('/home/me/file.ts',7);
});
it('plain-click matching leaves prose, gaps and executable URL schemes inert',()=>{
 const open=vi.fn(),path=vi.fn();
 for(const text of ['ordinary prose','javascript:alert(1)','data:text/html,hello','     https://example.test'])expect(activateNativePathHit({version:1,rows:[row(text)],row:0,column:2},path,open)).toBe(false);
 expect(open).not.toHaveBeenCalled();expect(path).not.toHaveBeenCalled();
});

it('hover uses the activation matcher without side effects and returns multi-row cell underlines',()=>{
 expect(nativePathHoverRects({version:1,rows:[row('/home/me/'),row('file.ts',true)],row:1,column:3})).toEqual([[0,-1,9,1],[0,0,7,1]]);
 expect(nativePathHoverRects({version:1,rows:[row('plain words')],row:0,column:2})).toEqual([]);
});
