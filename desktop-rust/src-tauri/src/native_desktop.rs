use serde_json::{json, Value};
use tauri::AppHandle;
pub struct ClipboardContents {
    pub value: Value,
    pub directory: tempfile::TempDir,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        sync::OnceLock,
    };
    static APP: OnceLock<AppHandle> = OnceLock::new();
    extern "C" {
        fn td_notifications_init(cb: extern "C" fn(*mut c_void, *const c_char), ctx: *mut c_void);
        fn td_notification_show(
            raw: *const c_char,
            cb: extern "C" fn(*mut c_void, *const c_char),
            ctx: *mut c_void,
        );
        fn td_notification_attention();
        fn td_menu_configure() -> bool;
        fn td_preview_service_menus() -> *mut c_char;
        fn td_clipboard_read(directory: *const c_char, image: bool) -> *mut c_char;
        fn td_clipboard_helper_limits() -> bool;
        fn td_clipboard_read_owned(directory:*const c_char,image:bool,name:*const c_char)->*mut c_char;
        fn td_clipboard_fixture_create(kind:*const c_char)->*mut c_char;
        fn td_clipboard_fixture_release(name:*const c_char);
        fn td_clipboard_fixture_verify_png(path:*const c_char,values:*mut u64)->bool;
        fn td_clipboard_child_rss(pid: i32) -> u64;
        fn td_string_free(value: *mut c_char);
        fn td_panel_configure(window: *mut c_void);
    }
    extern "C" fn clicked(_: *mut c_void, raw: *const c_char) {
        let Ok(payload) =
            serde_json::from_slice::<Value>(unsafe { CStr::from_ptr(raw) }.to_bytes())
        else {
            return;
        };
        if let Some(app) = APP.get() {
            crate::shell::notification_clicked(app, payload);
        }
    }
    extern "C" fn finished(context: *mut c_void, raw: *const c_char) {
        let tx: Box<tokio::sync::oneshot::Sender<Value>> = unsafe { Box::from_raw(context.cast()) };
        let payload = serde_json::from_slice(unsafe { CStr::from_ptr(raw) }.to_bytes())
            .unwrap_or(json!({"delivered":false,"error":"Invalid native receipt"}));
        let _ = tx.send(payload);
    }
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        unsafe {
            td_notifications_init(clicked, std::ptr::null_mut());
        }
    }
    pub async fn show(app: &AppHandle, payload: Value) -> Result<Value, String> {
        let raw = CString::new(payload.to_string()).map_err(|e| e.to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let context = Box::into_raw(Box::new(tx));
            unsafe {
                td_notification_show(raw.as_ptr(), finished, context.cast());
            }
        })
        .map_err(|e| e.to_string())?;
        // Authorization can await the user's choice. A timeout does not forge a
        // delivery ACK; native completion still owns and releases its callback.
        tokio::time::timeout(std::time::Duration::from_secs(60), rx)
            .await
            .map_err(|_| "Notification authorization timed out")?
            .map_err(|e| e.to_string())
    }
    fn marker(stage:&str){eprintln!("TDCP1 stage={stage}");}
    fn fixture(args:&[String])->Result<bool,String>{
        use std::{path::{Path,Component},os::unix::fs::{DirBuilderExt,OpenOptionsExt},io::Write};
        if !(args.len()==3||args.len()==4&&args[3]=="pdf"){return Err("Usage: --preview-clipboard-fixture NEW_ABSOLUTE_DIRECTORY [pdf]".into());}
        let root=Path::new(&args[2]);if !root.is_absolute()||root.components().any(|part|matches!(part,Component::ParentDir)){return Err("Fresh absolute fixture directory required".into());}
        std::fs::DirBuilder::new().mode(0o700).create(root).map_err(|_|"Fixture directory must not exist")?;
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|"Cannot start owned fixture collector")?;
        let mut cases=Vec::new();let executable=std::env::current_exe().map_err(|_|"Missing same signed executable")?;
        for kind in ["png","tiff","jpeg","pdf","pdf-too-large"]{
            if args.get(3).is_some_and(|selected|selected!=kind){continue;}
            let format=CString::new(kind).unwrap();let raw=unsafe{td_clipboard_fixture_create(format.as_ptr())};
            if raw.is_null(){cases.push(json!({"format":kind,"ok":false,"phase":"synthetic-image-setup"}));continue;}
            let setup=serde_json::from_slice::<Value>(unsafe{CStr::from_ptr(raw)}.to_bytes());unsafe{td_string_free(raw);}
            let setup=setup.map_err(|_|"Invalid synthetic setup receipt")?;
            let name=setup["name"].as_str().filter(|name|name.starts_with("termdock-preview-owned-")&&name.len()<=96).ok_or("Invalid owned pasteboard receipt")?;
            let board=CString::new(name).map_err(|_|"Invalid owned pasteboard name")?;
            let directory=crate::clipboard_collector::private_directory(Some(root)).map_err(|_|"Cannot create private fixture output")?;
            let arguments=["--preview-clipboard-fixture-helper".into(),"image".into(),directory.path().as_os_str().to_owned(),std::ffi::OsString::from(name)];
            let result=runtime.block_on(crate::clipboard_collector::collect_report(&executable,&arguments,||true,|pid|{let value=unsafe{td_clipboard_child_rss(pid as i32)};(value>0).then_some(value)},Default::default()));
            // Clear only this generated named board; never read or write general.
            unsafe{td_clipboard_fixture_release(board.as_ptr());}
            match result {
                Err(error)=>cases.push(json!({"format":kind,"ok":false,"error":error.message,"diagnostics":error.diagnostics})),
                Ok(output)=>{
                    let metadata=serde_json::from_slice::<Value>(&output.bytes).map_err(|_|"Invalid fixture image metadata")?;
                    if kind=="pdf-too-large" {
                        let rejected=metadata.get("error").and_then(Value::as_str)==Some("Clipboard image exceeds Preview's size limit")&&std::fs::read_dir(directory.path()).map(|mut entries|entries.next().is_none()).unwrap_or(false);
                        cases.push(json!({"format":kind,"ok":rejected,"rejectedBeforeOutput":rejected,"diagnostics":output.diagnostics}));continue;
                    }
                    let file=metadata["files"].as_array().filter(|files|files.len()==1).and_then(|files|files.first());
                    let mut metrics=[0_u64;3];let mut bytes=0;let mut valid=false;
                    if let Some(path)=file.and_then(|file|file["temporary"].as_str()){
                        let path=Path::new(path);let inside=path.canonicalize().ok().zip(directory.path().canonicalize().ok()).is_some_and(|(path,root)|path.starts_with(root));
                        if inside&&path.symlink_metadata().is_ok_and(|entry|entry.is_file()&&!entry.file_type().is_symlink()){
                            bytes=path.metadata().map(|entry|entry.len()).unwrap_or(0);
                            if bytes>0&&bytes<=128*1024*1024 {let encoded=CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_|"Invalid generated file name")?;valid=unsafe{td_clipboard_fixture_verify_png(encoded.as_ptr(),metrics.as_mut_ptr())};}
                        }
                    }
                    let ok=valid&&metrics[2]==1&&if kind=="pdf" { metrics[0]==metrics[1]&&(metrics[0]==8||metrics[0]==16) } else {metrics==[8,8,1]};cases.push(json!({"format":kind,"ok":ok,"outputType":"image/png","logicalPagePoints":if kind=="pdf"{Some([8,8])}else{None},"backingScale":if kind=="pdf"{Some(metrics[0] as f64/8.)}else{None},"dimensions":{"width":metrics[0],"height":metrics[1]},"imageCount":metrics[2],"outputBytes":bytes,"metadataBytes":output.bytes.len(),"metadataError":metadata.get("error").and_then(Value::as_str).map(|_|"Image collector reported a controlled image error"),"diagnostics":output.diagnostics}));
                }
            }
        }
        let ok=cases.iter().all(|case|case["ok"]==true);
        let report=json!({"source":option_env!("TERMDOCK_PREVIEW_SOURCE_REVISION"),"mode":"same-signed-helper-owned-named-pasteboard","ok":ok,"cases":cases,"generalPasteboardRead":false,"generalPasteboardWritten":false,"realPTY":false,"realUpload":false});
        let bytes=serde_json::to_vec_pretty(&report).map_err(|_|"Cannot serialize fixture report")?;
        if bytes.len()>32768{return Err("Fixture report exceeds bound".into());}
        std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(root.join("clipboard-fixture-report.json")).and_then(|mut file|file.write_all(&bytes)).map_err(|_|"Cannot persist private fixture report")?;
        std::io::stdout().write_all(&bytes).map_err(|_|"Cannot emit fixture report")?;Ok(ok)
    }
    pub fn helper_entry() -> bool {
        use std::io::Write;
        let args=std::env::args().collect::<Vec<_>>();
        if args.get(1).map(String::as_str)==Some("--preview-clipboard-fixture"){
            let code=match fixture(&args){Ok(true)=>0,Ok(false)=>1,Err(_)=>{eprintln!("Owned clipboard fixture setup failed");2}};std::process::exit(code);
        }
        let owned=args.get(1).map(String::as_str)==Some("--preview-clipboard-fixture-helper");
        if !owned&&args.get(1).map(String::as_str)!=Some("--preview-clipboard-helper"){return false;}
        marker("arguments");
        if args.len()!=(if owned{5}else{4})||!matches!(args[2].as_str(),"image"|"files"){std::process::exit(2);}
        let directory=std::path::Path::new(&args[3]);
        marker("directory");
        let allowed=crate::clipboard_collector::valid_private_directory(directory);
        if !allowed{std::process::exit(2);}
        let board=if owned{let name=&args[4];if name.len()>96||!name.starts_with("termdock-preview-owned-"){std::process::exit(2);}Some(CString::new(name.as_bytes()).unwrap_or_else(|_|std::process::exit(2)))}else{None};
        if !unsafe{td_clipboard_helper_limits()}{std::process::exit(2);}
        let path=CString::new(directory.as_os_str().as_encoded_bytes()).unwrap_or_else(|_|std::process::exit(2));
        marker("read");
        // Main-thread same executable, no Tauri/Node/windows/user config.
        let raw=unsafe{if let Some(board)=board{td_clipboard_read_owned(path.as_ptr(),args[2]=="image",board.as_ptr())}else{td_clipboard_read(path.as_ptr(),args[2]=="image")}};
        if raw.is_null(){std::process::exit(2);}
        marker("metadata");let output=unsafe{CStr::from_ptr(raw)}.to_bytes();marker("stdout");
        let result=if output.len()<=256*1024{std::io::stdout().write_all(output).and_then(|_|std::io::stdout().flush())}else{Err(std::io::Error::other("Clipboard metadata exceeds its bound"))};
        unsafe{td_string_free(raw);}if result.is_err(){std::process::exit(2);}marker("done");true
    }
    pub async fn clipboard(
        _: &AppHandle,
        image: bool,
        current: impl Fn() -> bool,
    ) -> Result<ClipboardContents, String> {
        let directory = crate::clipboard_collector::private_directory(None)
            .map_err(|e| e.to_string())?;
        let arguments = crate::clipboard_collector::arguments(image, directory.path());
        let bytes = crate::clipboard_collector::collect(
            &std::env::current_exe().map_err(|e| e.to_string())?,
            &arguments,
            current,
            |pid| {
                let rss = unsafe { td_clipboard_child_rss(pid as i32) };
                (rss > 0).then_some(rss)
            },
            Default::default(),
        )
        .await?;
        let value = serde_json::from_slice(&bytes).map_err(|_| "Invalid clipboard metadata")?;
        Ok(ClipboardContents { value, directory })
    }
    pub fn attention(app: &AppHandle) {
        let _ = app.run_on_main_thread(|| unsafe {
            td_notification_attention();
        });
    }
    /// Opt-in caller is already on AppKit. Own/free the C strdup result once.
    pub fn service_menus_on_main() -> Result<Value, String> {
        let raw=unsafe{td_preview_service_menus()};if raw.is_null(){return Err("Service menus require AppKit main thread".into());}
        let bytes=unsafe{CStr::from_ptr(raw)}.to_bytes();
        let result=if bytes.len()>16384 {Err("Service menu evidence exceeds bound".into())}else{serde_json::from_slice(bytes).map_err(|e|e.to_string())};
        unsafe{td_string_free(raw);}result
    }
    pub fn configure_menu(app: &AppHandle) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let result = if unsafe { td_menu_configure() } {
                Ok(())
            } else {
                Err("Preview zoom menu was not found".to_owned())
            };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    pub fn panel(window: &tauri::WebviewWindow) {
        if let Ok(raw) = window.ns_window() {
            let address = raw as usize;
            let _ = window.run_on_main_thread(move || unsafe {
                td_panel_configure(address as *mut c_void);
            });
        }
    }
}
#[cfg(target_os = "macos")]
pub use mac::*;
#[cfg(not(target_os = "macos"))]
pub fn helper_entry() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn init(_: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn configure_menu(_: &AppHandle) -> Result<(), String> {
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub async fn show(_: &AppHandle, _: Value) -> Result<Value, String> {
    Ok(json!({"delivered":false,"error":"Native notification backend requires macOS"}))
}
#[cfg(not(target_os = "macos"))]
pub async fn clipboard(
    _: &AppHandle,
    _: bool,
    _: impl Fn() -> bool,
) -> Result<ClipboardContents, String> {
    Err("Native clipboard collection requires macOS".into())
}
#[cfg(not(target_os = "macos"))]
pub fn attention(_: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn panel(_: &tauri::WebviewWindow) {}
