import {getTermdockDesktopBridge} from '../desktop/nativeBridge';
import {sendTmuxAction} from './api';

/** Explicit user copy writes to this computer, independently of the service. */
export async function writeTerminalClipboardText(text:string,current:()=>boolean=()=>true):Promise<boolean>{
 if(!text||!current())return false;
 const desktop=getTermdockDesktopBridge();
 if(desktop?.writeClipboardText){try{await desktop.writeClipboardText(text);return current();}catch{return false;}}
 try{await navigator.clipboard.writeText(text);return current();}catch{
  if(!current())return false;
  const previous=document.activeElement,textarea=document.createElement('textarea');
  textarea.value=text;textarea.readOnly=true;textarea.style.position='fixed';textarea.style.left='-9999px';
  document.body.append(textarea);
  try{textarea.select();return current()&&document.execCommand('copy');}catch{return false;}
  finally{textarea.remove();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});}
 }
}
/** Read a captured tmux selection through the current page's encrypted API. */
export async function copyTmuxTerminalSelection(session:string,current:()=>boolean):Promise<boolean>{
 if(!current())return false;
 const result=await sendTmuxAction(session,{action:'copy-selection'});
 if(!current())return false;
 const selection=result.selection;
 if(!result.success||!selection||!['copied','empty'].includes(selection.status)||typeof selection.text!=='string'||typeof selection.paneId!=='string'||!/^%[0-9]+$/.test(selection.paneId)||new TextEncoder().encode(selection.text).length!==selection.bytes||selection.bytes>262144)throw new Error('服务未返回有效的终端选区，请更新服务后重试。');
 if(selection.status==='empty')return false;
 if(!selection.bytes)throw new Error('终端选区为空。');
 return writeTerminalClipboardText(selection.text,current);
}
