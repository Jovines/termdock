//! Supervision of the signed executable's private OS clipboard collector.
//! No business HTTP, daemon lifecycle, shell command or arbitrary page path.
use std::{
    ffi::OsString,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};
pub fn arguments(image: bool, directory: &Path) -> [OsString; 3] {
    [
        "--preview-clipboard-helper".into(),
        (if image { "image" } else { "files" }).into(),
        directory.as_os_str().to_owned(),
    ]
}
/// Tempfile directories otherwise inherit 0777 & umask, which the helper
/// correctly refuses. Set owner-only permissions at creation, not after launch.
#[cfg(unix)]
pub fn private_directory(parent: Option<&Path>) -> std::io::Result<tempfile::TempDir> {
    use std::os::unix::fs::PermissionsExt;
    let mut builder = tempfile::Builder::new();
    builder.prefix("termdock-preview-clipboard-").permissions(std::fs::Permissions::from_mode(0o700));
    let directory = match parent { Some(parent) => builder.tempdir_in(parent), None => builder.tempdir() }?;
    if !valid_private_directory(directory.path()) { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Private clipboard directory was not created securely")); }
    Ok(directory)
}
#[cfg(unix)]
pub fn valid_private_directory(directory: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    directory.is_absolute()
        && directory.file_name().is_some_and(|name| name.to_string_lossy().starts_with("termdock-preview-clipboard-"))
        && directory.symlink_metadata().is_ok_and(|entry| entry.is_dir() && !entry.file_type().is_symlink() && entry.permissions().mode() & 0o777 == 0o700)
}
pub struct Budget {
    pub metadata: usize,
    pub rss: u64,
    pub wall: Duration,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            metadata: 256 * 1024,
            rss: 384 * 1024 * 1024,
            wall: Duration::from_secs(10),
        }
    }
}
/// Only fixed protocol markers are retained. Native framework stderr, image
/// bytes, pasteboard names, paths and arbitrary exception text never leave here.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct CollectorDiagnostics {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stages: Vec<String>,
    pub errno: Option<u32>,
    pub address_space_bytes: Option<u64>,
    pub cpu_seconds: Option<u64>,
    pub alarm_seconds: Option<u64>,
    pub markers_dropped: u32,
}
impl CollectorDiagnostics {
    fn line(&mut self, line: &[u8]) {
        let Ok(line)=std::str::from_utf8(line) else{return};
        let Some(value)=line.strip_prefix("TDCP1 ") else{return};
        if let Some(stage)=value.strip_prefix("stage=") {
            if !matches!(stage,"arguments"|"directory"|"limits-cpu"|"limits-timer"|"limits-vm"|"limits-as"|"limits-ready"|"read"|"pasteboard"|"types"|"image-data"|"image-source"|"image-properties"|"image-decode"|"image-destination"|"image-write"|"files"|"metadata"|"stdout"|"done"){return;}
            if self.stages.len()<32{self.stages.push(stage.into());}else{self.markers_dropped=self.markers_dropped.saturating_add(1);}
        } else if let Some((key,raw))=value.split_once('=') {
            let Ok(number)=raw.parse::<u64>()else{return};
            match key {"errno" if number<=i32::MAX as u64=>self.errno=Some(number as u32),"as"=>self.address_space_bytes=Some(number),"cpu"=>self.cpu_seconds=Some(number),"alarm"=>self.alarm_seconds=Some(number),_=>{}}
        }
    }
    fn status(&mut self,status:std::process::ExitStatus){
        self.exit_code=status.code();
        #[cfg(unix)] {use std::os::unix::process::ExitStatusExt;self.signal=status.signal();}
    }
}
#[derive(Debug)]
pub struct Collected {pub bytes:Vec<u8>,pub diagnostics:CollectorDiagnostics}
#[derive(Debug)]
pub struct CollectorFailure {pub message:String,pub diagnostics:CollectorDiagnostics}
impl std::fmt::Display for CollectorFailure {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        write!(f,"{} (exit={:?}, signal={:?}, phase={})",self.message,self.diagnostics.exit_code,self.diagnostics.signal,self.diagnostics.stages.last().map(String::as_str).unwrap_or("unreported"))
    }
}
impl CollectorFailure {
    fn user_message(&self)->&'static str {
        match self.message.as_str() {
            "Clipboard read window/target changed" => "目标服务或终端已切换，请重新粘贴。",
            "Clipboard collector exceeded its memory budget" | "Clipboard metadata exceeded its bound" => "剪贴板内容超出读取限制，请减少内容后重试。",
            "Clipboard collector exceeded its time budget" => "读取剪贴板超时，请重新复制后再试。",
            _ => "暂时无法读取剪贴板，请重新复制后再试。",
        }
    }
}
fn failed(message:impl ToString)->CollectorFailure{CollectorFailure{message:message.to_string(),diagnostics:Default::default()}}
struct DiagnosticReader(Option<tokio::task::JoinHandle<CollectorDiagnostics>>);
impl Drop for DiagnosticReader {fn drop(&mut self){if let Some(task)=&self.0{task.abort();}}}
impl DiagnosticReader {
    async fn finish(&mut self)->CollectorDiagnostics {
        let Some(mut task)=self.0.take() else{return Default::default()};
        // A child can pass an inherited descriptor to a descendant. Its own
        // exit must not make supervision wait indefinitely on that descriptor.
        match tokio::time::timeout(Duration::from_millis(100),&mut task).await {
            Ok(Ok(report))=>report,_=>{task.abort();Default::default()}
        }
    }
}
async fn diagnostic_stream(mut stream:impl tokio::io::AsyncRead+Unpin)->CollectorDiagnostics {
    let mut report=CollectorDiagnostics::default();let mut buffer=[0;1024];let mut line=Vec::with_capacity(128);let mut oversized=false;
    loop {let Ok(n)=stream.read(&mut buffer).await else{break};if n==0{break;}
        for byte in &buffer[..n]{if *byte==b'\n'{if !oversized{report.line(&line);}line.clear();oversized=false;}else if line.len()<127{line.push(*byte);}else{oversized=true;}}
    }
    // Continue draining all input with fixed buffers, even after the marker cap;
    // closing a full stderr pipe must not create a new SIGPIPE in the helper.
    report
}
pub async fn collect(
    executable:&Path,arguments:&[OsString],current:impl Fn()->bool,resident:impl Fn(u32)->Option<u64>,budget:Budget,
)->Result<Vec<u8>,String>{
    collect_report(executable,arguments,current,resident,budget).await.map(|value|value.bytes).map_err(|error|{
        // Keep process diagnostics in the host log, never in transient UI text.
        eprintln!("Termdock clipboard collector: {error}");error.user_message().to_owned()
    })
}
pub async fn collect_report(
    executable:&Path,arguments:&[OsString],current:impl Fn()->bool,resident:impl Fn(u32)->Option<u64>,budget:Budget,
)->Result<Collected,CollectorFailure>{
    let mut child=Command::new(executable).args(arguments).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(failed)?;
    let pid=child.id().ok_or_else(||failed("Clipboard collector did not start"))?;
    let stdout=child.stdout.take().ok_or_else(||failed("Missing clipboard metadata channel"))?;
    let stderr=child.stderr.take().ok_or_else(||failed("Missing clipboard diagnostic channel"))?;
    let mut diagnostics=DiagnosticReader(Some(tokio::spawn(diagnostic_stream(stderr))));
    let cap=budget.metadata;
    let mut reader=Some(tokio::spawn(async move{let mut bytes=Vec::new();stdout.take(cap as u64+1).read_to_end(&mut bytes).await.map(|_|bytes)}));
    let mut output=None;let start=Instant::now();
    let status=loop {
        if reader.as_ref().is_some_and(|r|r.is_finished()){
            let bytes=reader.take().unwrap().await.map_err(failed)?.map_err(failed)?;
            if bytes.len()>cap{let _=child.kill().await;let mut report=diagnostics.finish().await;if let Ok(status)=child.wait().await{report.status(status);}return Err(CollectorFailure{message:"Clipboard metadata exceeded its bound".into(),diagnostics:report});}
            output=Some(bytes);
        }
        if let Some(status)=child.try_wait().map_err(failed)?{break status;}
        let rss=resident(pid);
        // proc_pidinfo can lose the process between the first wait and RSS
        // sample. Reap a completed child through the normal status/metadata
        // path; an unknown RSS for a still-live child remains fail-closed.
        if rss.is_none(){if let Some(status)=child.try_wait().map_err(failed)?{break status;}}
        let violation=if !current(){Some("Clipboard read window/target changed")}else if start.elapsed()>budget.wall{Some("Clipboard collector exceeded its time budget")}else if rss.is_some_and(|rss|rss>budget.rss){Some("Clipboard collector exceeded its memory budget")}else if rss.is_none()&&start.elapsed()>Duration::from_millis(100){Some("Cannot verify clipboard collector memory budget")}else{None};
        if let Some(error)=violation{
            let _=child.kill().await;
            let status=child.wait().await;
            // The child can also complete normally between the second wait
            // and kill. Only unknown-RSS supervision may accept that success;
            // measured over-budget, timeout and stale-owner failures stay failures.
            if error=="Cannot verify clipboard collector memory budget"&&status.as_ref().is_ok_and(|status|status.success()){break status.unwrap();}
            if let Some(reader)=reader{reader.abort();}
            let mut report=diagnostics.finish().await;if let Ok(status)=status{report.status(status);}
            return Err(CollectorFailure{message:error.into(),diagnostics:report});
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let mut report=diagnostics.finish().await;report.status(status);
    if !status.success(){if let Some(reader)=reader{reader.abort();}return Err(CollectorFailure{message:"Clipboard collector failed; no data was returned".into(),diagnostics:report});}
    let bytes=match output{Some(bytes)=>bytes,None=>reader.unwrap().await.map_err(failed)?.map_err(failed)?};
    if bytes.len()>cap{return Err(CollectorFailure{message:"Clipboard metadata exceeded its bound".into(),diagnostics:report});}
    if !current(){return Err(CollectorFailure{message:"Clipboard read window/target changed".into(),diagnostics:report});}
    Ok(Collected{bytes,diagnostics:report})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn parent_and_helper_share_owner_only_directory_contract() {
        use std::os::unix::fs::{PermissionsExt,symlink};
        let directory=private_directory(None).unwrap();
        assert_eq!(directory.path().metadata().unwrap().permissions().mode()&0o777,0o700);
        assert!(valid_private_directory(directory.path()));
        let nested=private_directory(Some(directory.path())).unwrap();assert!(valid_private_directory(nested.path()));
        let link=directory.path().join("termdock-preview-clipboard-link");symlink(nested.path(),&link).unwrap();assert!(!valid_private_directory(&link));
        std::fs::set_permissions(nested.path(),std::fs::Permissions::from_mode(0o755)).unwrap();assert!(!valid_private_directory(nested.path()));
        assert!(!valid_private_directory(Path::new("termdock-preview-clipboard-relative")));
    }
    #[test]
    fn helper_image_and_file_modes_and_private_directory_are_separate_literal_arguments() {
        let path = Path::new("/tmp/termdock-preview-clipboard-name with spaces");
        for image in [true, false] {
            let args = arguments(image, path);
            assert_eq!(args.len(), 3);
            assert_eq!(args[0], "--preview-clipboard-helper");
            assert_eq!(args[1], if image { "image" } else { "files" });
            assert_eq!(args[2], path.as_os_str());
        }
    }
    #[cfg(target_os="linux")]
    #[tokio::test]
    async fn actual_child_diagnostics_report_exit_signal_and_only_fixed_bounded_markers() {
        let script=r#"import sys;sys.stderr.write('private-image-name-not-for-report\n'*100000);sys.stderr.write('\nTDCP1 stage=read\nTDCP1 as=536870912\nTDCP1 cpu=8\nTDCP1 alarm=10\nTDCP1 errno=12\nTDCP1 stage=/private/untrusted\n');sys.stderr.flush();sys.exit(2)"#;
        let failure=collect_report(Path::new("/usr/bin/python3"),&["-c".into(),script.into()],||true,|_|Some(1),Budget{metadata:4096,rss:1024*1024*1024,wall:Duration::from_secs(2)}).await.unwrap_err();
        assert_eq!(failure.diagnostics.exit_code,Some(2));assert_eq!(failure.diagnostics.signal,None);
        assert_eq!(failure.diagnostics.stages,["read"]);assert_eq!(failure.diagnostics.errno,Some(12));assert_eq!(failure.diagnostics.address_space_bytes,Some(536870912));assert_eq!(failure.diagnostics.cpu_seconds,Some(8));assert_eq!(failure.diagnostics.alarm_seconds,Some(10));
        assert!(!failure.to_string().contains("private"));
        let failure=collect_report(Path::new("/usr/bin/python3"),&["-c".into(),"import os,signal,sys;sys.stderr.write('TDCP1 stage=limits-as\\n');sys.stderr.flush();os.kill(os.getpid(),signal.SIGTERM)".into()],||true,|_|Some(1),Budget{metadata:4096,rss:1024*1024*1024,wall:Duration::from_secs(2)}).await.unwrap_err();
        assert_eq!(failure.diagnostics.exit_code,None);assert_eq!(failure.diagnostics.signal,Some(15));assert_eq!(failure.diagnostics.stages,["limits-as"]);
        let mut bounded=CollectorDiagnostics::default();for _ in 0..100{bounded.line(b"TDCP1 stage=read");}assert_eq!(bounded.stages.len(),32);assert_eq!(bounded.markers_dropped,68);
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn real_children_are_bounded_cancelled_reaped_and_fail_closed() {
        fn rss(pid: u32) -> Option<u64> {
            let text = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
            text.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
                .map(|k| k * 1024)
        }
        let cases = [
            (
                "print('metadata')",
                4096,
                1024 * 1024 * 1024,
                1000,
                true,
                None,
            ),
            (
                "import sys;sys.stdout.write('x'*8192)",
                4096,
                1024 * 1024 * 1024,
                1000,
                true,
                Some("metadata"),
            ),
            (
                "import time;time.sleep(2)",
                4096,
                1024 * 1024 * 1024,
                50,
                true,
                Some("time budget"),
            ),
            (
                "import time;time.sleep(2)",
                4096,
                1,
                1000,
                true,
                Some("memory budget"),
            ),
            (
                "import time;time.sleep(2)",
                4096,
                1024 * 1024 * 1024,
                1000,
                false,
                Some("window/target"),
            ),
            (
                "import sys;sys.exit(3)",
                4096,
                1024 * 1024 * 1024,
                1000,
                true,
                Some("failed"),
            ),
        ];
        for (script, metadata, limit, wall, current, error) in cases {
            let pid = std::sync::atomic::AtomicU32::new(0);
            let result = collect_report(
                Path::new("/usr/bin/python3"),
                &["-c".into(), script.into()],
                || current,
                |id| {
                    pid.store(id, std::sync::atomic::Ordering::SeqCst);
                    rss(id)
                },
                Budget {
                    metadata,
                    rss: limit,
                    wall: Duration::from_millis(wall),
                },
            )
            .await;
            if let Some(error) = error {
                assert!(result.unwrap_err().message.contains(error));
            } else {
                assert_eq!(result.unwrap().bytes, b"metadata\n");
            }
            let pid = pid.load(std::sync::atomic::Ordering::SeqCst);
            if pid != 0 {
                assert!(
                    !Path::new(&format!("/proc/{pid}")).exists(),
                    "only the owned child must be reaped"
                );
            }
        }
        let result = collect_report(
            Path::new("/usr/bin/python3"),
            &["-c".into(), "import time;time.sleep(2)".into()],
            || true,
            |_| None,
            Budget {
                metadata: 4096,
                rss: 1024 * 1024 * 1024,
                wall: Duration::from_secs(1),
            },
        )
        .await;
        assert!(result.unwrap_err().message.contains("Cannot verify"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn an_exit_between_wait_and_rss_uses_the_success_and_metadata_checks() {
        use std::{cell::Cell,fs,process::Command as Process};
        for (metadata,current,error) in [(1024,true,None),(4,true,Some("metadata")),(1024,false,Some("window/target"))] {
        let directory=tempfile::tempdir().unwrap();let ready=directory.path().join("ready");let release=directory.path().join("release");
        let script="import pathlib,sys,time;ready,release=map(pathlib.Path,sys.argv[1:]);ready.touch();\nwhile not release.exists(): time.sleep(.001)\nsys.stdout.write('metadata');sys.stdout.flush();sys.stderr.write('TDCP1 stage=done\\n');sys.stderr.flush()";
        let sampled=Cell::new(false);let started=Instant::now();
        let result=collect_report(Path::new("/usr/bin/python3"),&["-c".into(),script.into(),ready.into_os_string(),release.clone().into_os_string()],||current,|pid|{
            assert!(!sampled.replace(true));
            // Hold the child alive until the initial try_wait has returned None,
            // then release it inside this exact RSS callback after the grace.
            let deadline=Instant::now()+Duration::from_secs(3);
            while !directory.path().join("ready").exists()||started.elapsed()<Duration::from_millis(120){assert!(Instant::now()<deadline);std::thread::yield_now();}
            fs::write(&release,b"exit").unwrap();
            loop {
                let status=Process::new("/bin/ps").args(["-p",&pid.to_string(),"-o","stat="]).output().unwrap();
                if !status.status.success()||String::from_utf8_lossy(&status.stdout).trim_start().starts_with('Z'){break;}
                assert!(Instant::now()<deadline);std::thread::yield_now();
            }
            None
        },Budget{metadata,rss:1024*1024*1024,wall:Duration::from_secs(4)}).await;
        assert!(sampled.get());
        match error {
            Some(message)=>{let failure=result.unwrap_err();assert!(failure.message.contains(message));assert_eq!(failure.diagnostics.exit_code,Some(0));},
            None=>{let output=result.unwrap();assert_eq!(output.bytes,b"metadata");assert_eq!(output.diagnostics.exit_code,Some(0));assert_eq!(output.diagnostics.stages,["done"]);}
        }
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn fast_exit_and_measured_long_read_succeed_but_live_unknown_and_over_budget_fail() {
        for _ in 0..6 {
            let output=collect_report(Path::new("/bin/echo"),&["metadata".into()],||true,|_|None,Budget{metadata:1024,rss:1024*1024,wall:Duration::from_secs(2)}).await.unwrap();assert_eq!(output.bytes,b"metadata\n");
        }
        for (rss,expected) in [(Some(1),None),(None,Some("Cannot verify")),(Some(2048),Some("memory budget"))] {
            let result=collect_report(Path::new("/usr/bin/python3"),&["-c".into(),"import time;time.sleep(.2);print('metadata')".into()],||true,|_|rss,Budget{metadata:1024,rss:1024,wall:Duration::from_secs(2)}).await;
            match expected {Some(message)=>assert!(result.unwrap_err().message.contains(message)),None=>assert_eq!(result.unwrap().bytes,b"metadata\n")}
        }
    }
    #[test]
    fn user_feedback_never_contains_process_diagnostics() {
        let failure=CollectorFailure{message:"Cannot verify clipboard collector memory budget".into(),diagnostics:CollectorDiagnostics{exit_code:Some(0),stages:vec!["done".into()],..Default::default()}};
        assert!(failure.to_string().contains("exit=Some(0)"));assert_eq!(failure.user_message(),"暂时无法读取剪贴板，请重新复制后再试。");assert!(!failure.user_message().contains("exit"));
    }

}
