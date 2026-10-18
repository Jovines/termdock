//! Actual owned AppKit keyDown/interpretKeyEvents/insertText -> Ghostty Input.
//! Synthetic NSEvents only: no OS event posting, paste, clipboard, shell or PTY.
#[cfg(any(target_os="macos",feature="check-native-api"))]
fn run()->Result<(),Box<dyn std::error::Error>>{
 use std::{ffi::c_void,ptr::NonNull,time::{Duration,Instant}};
 use termdock_native_terminal::{macos::{NativePanel,NativeError,Rect},Error,HostEvent,Options,Ownership,Palette};
 extern "C" {
  fn td_native_keyboard_window()->*mut c_void;
  fn td_native_keyboard_case(window:*mut c_void,which:u32)->bool;
  fn td_native_keyboard_stages(window:*mut c_void,stages:*mut u64)->bool;
  fn td_native_keyboard_step();
  fn td_native_demo_parent(window:*mut c_void)->*mut c_void;
  fn td_native_demo_bounds(window:*mut c_void,w:*mut f64,h:*mut f64,scale:*mut f64);
  fn td_native_demo_close(window:*mut c_void);
 }
 let palette:Palette=serde_json::from_slice(&std::fs::read(std::env::args().nth(1).ok_or("keyboard_fixture <palette.json>")?)?)?;
 let owner=Ownership{service:"owned-keyboard".into(),target:"owned-keyboard".into(),session:"no-pty".into(),device:"fixture".into(),window:"fixture".into(),view:"fixture".into(),epoch:"fixture".into()};
 unsafe{
  let window=NonNull::new(td_native_keyboard_window()).ok_or("owned window creation failed")?;
  let parent=NonNull::new(td_native_demo_parent(window.as_ptr())).ok_or("owned parent absent")?;
  let mut panel=NativePanel::create(parent,Options{font:Default::default(),columns:80,rows:24,history:100,palette,cursor_visible:true,cursor_blink:true},owner,13.)?;
  let (mut w,mut h,mut scale)=(0.,0.,0.);td_native_demo_bounds(window.as_ptr(),&mut w,&mut h,&mut scale);
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{
   for event in panel.pump()?{if let HostEvent::Fatal(reason)=event{return Err(reason.into());}}
   match panel.set_rect(Rect{x:0.,y:0.,width:w,height:h,scale}){
    Ok(_)=>break,
    Err(NativeError::Terminal(Error::Backpressure)) if Instant::now()<deadline=>td_native_keyboard_step(),
    Err(error)=>return Err(error.into()),
   }
  }
  panel.set_visible(true)?;
  let names=["a","b","shift-a","enter","tab","delete"];
  let expected:[&[u8];6]=[b"a",b"b",b"A",b"\r",b"\t",b"\x7f"];
  let mut cases=Vec::new();let mut all=true;
  for which in 0..6{
   let deadline=Instant::now()+Duration::from_secs(2);let mut injected=false;let mut bytes=Vec::new();let mut stages=[0u64;20];
   loop{
    td_native_keyboard_step();
    for event in panel.pump()?{match event{HostEvent::Input(value) if injected=>{if bytes.len()+value.len()>256{return Err("owned key output budget exceeded".into());}bytes.extend(value);},HostEvent::Fatal(reason)=>return Err(reason.into()),_=>{}}}
    if !injected{injected=td_native_keyboard_case(window.as_ptr(),which as u32);}
    if injected{td_native_keyboard_stages(window.as_ptr(),stages.as_mut_ptr());}
    if injected&&!bytes.is_empty()&&stages[13]==0&&stages[14]==0{break;}
    if Instant::now()>=deadline{break;}
   }
   let ok=injected&&bytes==expected[which];all&=ok;
   cases.push(serde_json::json!({"case":names[which],"ok":ok,"injected":injected,"inputBytes":bytes,"stages":stages}));
  }
  panel.close()?;drop(panel);td_native_demo_close(window.as_ptr());
  println!("{}",serde_json::json!({"ok":all,"cases":cases,"syntheticNSEvent":true,"physicalKeysTested":false,"pasteUsed":false,"generalPasteboardTouched":false,"networkOrPTY":false}));
  if !all{return Err("Owned keyboard case did not emit exact expected input".into());}
 }
 Ok(())
}
#[cfg(target_os="macos")]
fn main()->Result<(),Box<dyn std::error::Error>>{run()}
#[cfg(not(target_os="macos"))]
fn main(){eprintln!("Requires actual AppKit/Ghostty on the owned build Mac");}
