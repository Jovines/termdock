/** Font shortcuts belong to the focused terminal, not the WebView zoom menu. */
export function nativeSessionFontShortcut(key:string,modifiers:number):'increase'|'decrease'|'reset'|null {
  const mods=modifiers&15;
  if(mods!==8&&mods!==9)return null;
  if(key==='+'||key==='=')return 'increase';
  if(mods===8&&key==='-')return 'decrease';
  if(mods===8&&key==='0')return 'reset';
  return null;
}

/** Match the existing Preview menu contract using physical bracket codes and
 * logical characters. Ghostty encodes non-Command terminal keys itself. */
export function nativeMenuShortcut(key:string,keyCode:number,modifiers:number):string|null {
  if(!(modifiers&8)||(modifiers&2))return null;
  const shift=!!(modifiers&1),alt=!!(modifiers&4);key=key.toLowerCase();
  if(keyCode===33||keyCode===30){const direction=keyCode===33?'previous':'next';if(alt&&!shift)return direction+'-attention';if(shift&&!alt)return direction+'-session';}
  if(alt)return null;
  if(key===',')return 'settings';
  if(key==='n'&&!shift)return 'new-connection';
  if(key==='t'&&!shift)return 'new-session';
  if(key==='w'&&!shift)return 'close-session';
  if(key==='b')return shift?'toggle-right-sidebar':'toggle-left-sidebar';
  if(key==='r')return shift?'force-reload':'reload';
  if(key==='0'&&!shift)return 'reset-zoom';
  if(key==='+'||key==='=')return 'zoom-in';
  if(key==='-'&&!shift)return 'zoom-out';
  if(key==='o'&&shift)return 'connection-center';
  return null;
}

/** AppKit return/delete/arrow keys arrive as control/private-use characters.
 * Normalize only known special keycodes, never an unknown Command chord. */
export function nativeTerminalShortcut(key:string,keyCode:number,modifiers:number):{kind:'clear'}|{kind:'input';data:string}|null {
  const mods=modifiers&15;
  const special=({36:'Enter',76:'Enter',51:'Backspace',117:'Delete',123:'ArrowLeft',124:'ArrowRight'} as Record<number,string>)[keyCode];
  const normalized=special??key;
  if((mods===8||mods===2||mods===10)&&key.toLowerCase()==='k')return {kind:'clear'};
  if(mods!==8)return null;
  const data=({Enter:'\r',Backspace:'\x15',Delete:'\x0b',ArrowLeft:'\x01',ArrowRight:'\x05'} as Record<string,string>)[normalized];
  return data?{kind:'input',data}:null;
}
