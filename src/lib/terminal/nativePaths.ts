import type {Terminal, ILinkProvider} from '@xterm/xterm';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {createTerminalPathLinkProvider} from './pathLinks';
type Cell={chars:string;width:number;fgMode:number;fgColor:number};
type Slice={version:1;row:number;column:number;rows:Array<{wrapped:boolean;cells:Cell[]}>};
/** Temporary read-only engine cells, only for an explicit link click. Reuse the
 * original soft/hard-wrap path matcher; no VT parser, renderer or lasting grid. */
export function activateNativePathHit(value:unknown,activate:((path:string,line?:number)=>void)|undefined,openUrl?: (url:string)=>void):boolean {
 const data=value as Slice;
 if(!data||data.version!==1||!Array.isArray(data.rows)||data.rows.length>64||!Number.isSafeInteger(data.row)||!Number.isSafeInteger(data.column)||data.row<0||data.row>=data.rows.length||data.column<0)return false;
 let count=0;
 for(const row of data.rows){if(!row||typeof row.wrapped!=='boolean'||!Array.isArray(row.cells)||(count+=row.cells.length)>4096)return false;
  for(const cell of row.cells)if(!cell||typeof cell.chars!=='string'||cell.chars.length>4096||![0,1,2].includes(cell.width)||![0,1,2].includes(cell.fgMode)||!Number.isSafeInteger(cell.fgColor)||cell.fgColor<0||cell.fgColor>0xffffff)return false;
 }
 if(data.column>=data.rows[data.row].cells.length)return false;
 let webProvider:ILinkProvider|undefined;
 const terminal={registerLinkProvider(provider:ILinkProvider){webProvider=provider;return{dispose(){}};},buffer:{active:{length:data.rows.length,getNullCell:()=>({getChars:()=>'',getWidth:()=>1}),getLine(index:number){const row=data.rows[index];if(!row)return undefined;return{
  length:row.cells.length,isWrapped:row.wrapped,
  translateToString(trim=false){const text=row.cells.filter(cell=>cell.width!==0).map(cell=>cell.chars||' ').join('');return trim?text.trimEnd():text;},
  getCell(column:number,target?:object){const cell=row.cells[column];if(!cell)return undefined;const value={getChars:()=>cell.chars,getWidth:()=>cell.width,isFgDefault:()=>cell.fgMode===0,getFgColorMode:()=>cell.fgMode,getFgColor:()=>cell.fgColor};return target?Object.assign(target,value):value;},
 };}}}} as unknown as Terminal;
 let found=false;
 const hit:Parameters<ILinkProvider['provideLinks']>[1]=links=>{
  const point={x:data.column+1,y:data.row+1};
  const link=links?.find(link=>(point.y>link.range.start.y||point.y===link.range.start.y&&point.x>=link.range.start.x)&&(point.y<link.range.end.y||point.y===link.range.end.y&&point.x<=link.range.end.x));
  if(link){found=true;link.activate(new MouseEvent('click'),link.text);}
 };
 // Reuse xterm's bounded URL matching and wide/soft-wrapped cell mapping.
 // Command-click URLs remain Ghostty-owned; only plain clicks use this branch.
 if(openUrl){const addon=new WebLinksAddon((_event,url)=>{try{const parsed=new URL(url);if(['http:','https:'].includes(parsed.protocol))openUrl(parsed.href);}catch{/* Inert malformed text. */}});try{addon.activate(terminal);webProvider?.provideLinks(data.row+1,hit);}finally{addon.dispose();}}
 if(!found&&activate)createTerminalPathLinkProvider(terminal,activate).provideLinks(data.row+1,hit);
 return found;
}
