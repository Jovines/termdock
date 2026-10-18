// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {activateNativePathHit} from './nativePaths';
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
