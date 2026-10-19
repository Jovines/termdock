//! Actual Ghostty surface. All host methods/drop are AppKit main thread only.
//! One worker serializes feeds and IO barriers. No AppKit calls on that worker.
use crate::core::{self, EventQueue, ReplayRecord};
use crate::{Envelope, Error, Font, HostEvent, Options, Ownership, Palette, Replay, Submission};
use serde_json::Value;
use std::{
    collections::VecDeque,
    ffi::{c_char, c_int, c_void, CString},
    marker::PhantomData,
    ptr::NonNull,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
};
fn defer_focus_intent(closed: bool, poisoned: bool, apply: impl FnOnce()) -> Result<(), Error> {
    if closed { return Err(Error::Closed); }
    if poisoned { return Err(Error::EngineFailed); }
    apply(); Ok(())
}
#[cfg(test)]
mod focus_intent_tests {
    use super::*;
    #[test]
    fn metadata_intent_has_no_idle_barrier_and_retains_terminal_failures() {
        // Pure dispatch policy only; this does not construct a busy AppKit panel.
        let mut intents=0;
        assert_eq!(defer_focus_intent(false,false,||intents+=1),Ok(()));
        assert_eq!(intents,1);
        assert_eq!(defer_focus_intent(true,false,||intents+=1),Err(Error::Closed));
        assert_eq!(defer_focus_intent(false,true,||intents+=1),Err(Error::EngineFailed));
        assert_eq!(intents,1);
    }
}
#[derive(Debug, thiserror::Error)]
pub enum NativeError {
    #[error("native presentation applied; terminal grid is pending")]
    LayoutPending,
    #[error("AppKit main thread required")]
    MainThread,
    #[error("invalid view geometry, scale, or Ghostty grid budget")]
    Geometry,
    #[error("AppKit could not return text input to the owning service page")]
    FocusTransfer,
    #[error("locked Ghostty surface or config initialization failed")]
    Initialization,
    #[error(transparent)]
    Terminal(#[from] Error),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderStats {
    pub attempts: u64,
    pub submissions: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchResult {
    pub total: isize,
    pub selected: isize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum CopyTextResult { Copied, Empty, TooLarge, Unreadable }
impl CopyTextResult {
    fn from_host(status:c_int)->Self { match status {1=>Self::Copied,2=>Self::Empty,3=>Self::TooLarge,_=>Self::Unreadable} }
}
struct Callbacks {
    queue: EventQueue,
    poisoned: AtomicBool,
    replaying: AtomicBool,
}
unsafe extern "C" fn receive(
    context: *mut c_void,
    kind: u32,
    data: *const u8,
    len: usize,
    a: u64,
    b: u64,
) -> i32 {
    let cb = &*(context as *const Callbacks);
    if kind == 16 {
        cb.queue.wake.wake();
        return 1;
    }
    if kind == 9 {
        return cb.queue.can_accept_input() as i32;
    }
    if len > core::MAX_BATCH_BYTES || (len != 0 && data.is_null()) {
        cb.poisoned.store(true, Ordering::Release);
        return 0;
    }
    if matches!(kind, 0 | 1 | 3 | 4) && cb.replaying.load(Ordering::Acquire) {
        return 1;
    }
    let bytes = if len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(data, len).to_vec()
    };
    let event = match kind {
        0 => HostEvent::Input(bytes),
        1 => HostEvent::Resize {
            columns: a as usize,
            rows: b as usize,
        },
        2 => HostEvent::Selection(String::from_utf8_lossy(&bytes).into_owned()),
        3 => HostEvent::Title(String::from_utf8_lossy(&bytes).into_owned()),
        4 => HostEvent::Bell,
        5 => HostEvent::InputRejected,
        21 if (1..=3).contains(&a) => HostEvent::CopyFailed(a as u8),
        6 => HostEvent::SearchRequested(String::from_utf8_lossy(&bytes).into_owned()),
        7 => HostEvent::CloseRequested,
        8 => HostEvent::LayoutRequested,
        11 => HostEvent::Shortcut {
            key_code: a as u16,
            modifiers: b as u32,
            key: String::from_utf8_lossy(&bytes).into_owned(),
        },
        12 => HostEvent::PasteRequested,
        14 => HostEvent::Wheel(String::from_utf8_lossy(&bytes).into_owned()),
        15 => HostEvent::PointerPressed,
        22 if a<=1 && b>0 => HostEvent::FocusChanged { focused:a==1, revision:b },
        17 => HostEvent::ClipboardText(String::from_utf8_lossy(&bytes).into_owned()),
        18 => HostEvent::OpenLink(String::from_utf8_lossy(&bytes).into_owned()),
        23 | 24 => HostEvent::PathHover { text: String::from_utf8_lossy(&bytes).into_owned(), revision: a, partial: kind == 24 },
        19 => HostEvent::PathHit { text: String::from_utf8_lossy(&bytes).into_owned(), plain_click: a == 1 },
        20 => {
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return 0 };
            let Some(values) = value.as_array().filter(|items| !items.is_empty() && items.len() <= 50) else { return 0 };
            let mut paths = Vec::with_capacity(values.len());
            for item in values {
                let Some(path) = item.as_str().filter(|path| path.starts_with('/') && !path.contains('\0')) else { return 0 };
                paths.push(path.to_owned());
            }
            HostEvent::FileDrop(paths)
        }
        10 => {
            cb.poisoned.store(true, Ordering::Release);
            HostEvent::Fatal(String::from_utf8_lossy(&bytes).into_owned())
        }
        _ => return 0,
    };
    // Native main operations are gated while a feed/barrier is running.
    // Main callbacks cannot wait; IO callbacks can wait until pump drains.
    let io = td_native_is_main_thread() == 0;
    match cb.queue.push(event, io) {
        Ok(()) => 1,
        Err(Error::Closed) => 0,
        Err(_) => {
            cb.poisoned.store(true, Ordering::Release);
            0
        }
    }
}
extern "C" {
    fn td_native_is_main_thread() -> i32;
    fn td_native_create(
        parent: *mut c_void,
        ctx: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, u32, *const u8, usize, u64, u64) -> i32,
        config: *const c_char,
        font: f32,
        cols: u16,
        rows: u16,
        history: u32,
    ) -> *mut c_void;
    fn td_native_destroy(handle: *mut c_void);
    fn td_native_cancel(handle: *mut c_void);
    fn td_native_drain_app(handle: *mut c_void) -> bool;
    fn td_native_pump_io(handle: *mut c_void) -> i32;
    fn td_native_view(handle: *mut c_void) -> *mut c_void;
    fn td_native_feed(handle: *mut c_void, data: *const u8, len: usize) -> bool;
    fn td_native_barrier(handle: *mut c_void) -> bool;
    fn td_native_worker_busy(handle: *mut c_void, busy: bool);
    fn td_native_is_busy(handle: *mut c_void) -> bool;
    fn td_native_pump(handle: *mut c_void) -> i32;
    fn td_native_rect(
        handle: *mut c_void,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        scale: f64,
        cols: *mut u16,
        rows: *mut u16,
    ) -> i32;
    fn td_native_replay_size(
        handle: *mut c_void,
        w: u32,
        h: u32,
        scale: f64,
        columns: u16,
        rows: u16,
    ) -> bool;
    fn td_native_palette(handle: *mut c_void, config: *const c_char) -> bool;
    fn td_native_dimensions(
        handle: *mut c_void,
        w: *mut u32,
        h: *mut u32,
        scale: *mut f64,
        cols: *mut u16,
        rows: *mut u16,
    );
    fn td_native_focus(handle: *mut c_void);
    fn td_native_link_hover(handle: *mut c_void, revision: u64, rects: *const f64, count: usize) -> bool;
    fn td_native_policy(handle: *mut c_void, tmux: bool);
    fn td_native_history(handle: *mut c_void, history: u32);
    fn td_native_bind_webview(handle:*mut c_void,wk_view:*mut c_void)->bool;
    fn td_native_blur(handle: *mut c_void)->bool;
    fn td_native_action(handle: *mut c_void, action: *const c_char, len: usize) -> bool;
    fn td_native_text(handle: *mut c_void, text: *const u8, len: usize);
    fn td_native_read_text(handle: *mut c_void, selection: bool) -> c_int;
    fn td_native_attachment(handle:*mut c_void,wk_view:*mut c_void)->u32;
    fn td_native_cursor(handle: *mut c_void, x: *mut u32, y: *mut u32);
    fn td_native_input_blocked(handle:*mut c_void,blocked:bool);
    fn td_native_clip(handle: *mut c_void, rects: *const f64, count: usize) -> bool;
    fn td_native_present_layout(handle:*mut c_void,x:f64,y:f64,w:f64,height:f64,rects:*const f64,count:usize,visible:bool)->c_int;
    fn td_native_layout(handle:*mut c_void,x:f64,y:f64,w:f64,height:f64,scale:f64,rects:*const f64,count:usize,resize:bool,visible:bool,cols:*mut u16,rows:*mut u16)->c_int;
    fn td_native_visible(handle: *mut c_void, visible: bool)->bool;
    fn td_native_replaying(handle: *mut c_void, replaying: bool);
    fn td_native_snapshot(
        handle: *mut c_void,
        bytes: *mut u8,
        cap: usize,
        len: *mut usize,
    ) -> c_int;
    fn td_native_snapshot_finish(handle: *mut c_void, bytes: *const u8, len: usize) -> bool;
    fn td_native_flush_sync(handle: *mut c_void);
    fn td_native_viewport(handle: *mut c_void) -> usize;
    fn td_native_render_stats(handle: *mut c_void, attempts: *mut u64, submissions: *mut u64);
    fn td_native_geometry(handle: *mut c_void, phase: u32, values: *mut f64) -> bool;
    fn td_native_window_geometry(wk_view: *mut c_void, values: *mut f64) -> bool;
    fn td_native_restore_viewport(handle: *mut c_void, offset: usize) -> bool;
    fn td_native_search(
        handle: *mut c_void,
        needle: *const c_char,
        len: usize,
        direction: i32,
        total: *mut isize,
        selected: *mut isize,
    ) -> i32;
}
fn main_thread() -> Result<(), NativeError> {
    if unsafe { td_native_is_main_thread() } != 0 {
        Ok(())
    } else {
        Err(NativeError::MainThread)
    }
}
fn color(v: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", v[0], v[1], v[2])
}
fn config(options: &Options, font_size: f64) -> CString {
    let p = &options.palette;
    let mut s=format!("font-family = {}\nfont-size = {font_size}\nwindow-padding-x = 0\nwindow-padding-y = 0\nwindow-padding-balance = false\nscrollback-limit = {}\nimage-storage-limit = 33554432\nclipboard-read = deny\nclipboard-write = deny\ncursor-style-blink = {}\ncursor-opacity = {}\nwindow-vsync = false\ncustom-shader-animation = false\nbackground-opacity = 1\nforeground = {}\nbackground = {}\ncursor-color = {}\nselection-background = {}\nkeybind = clear\nmacos-option-as-alt = true\n",options.font.family,core::history_bytes(options),options.cursor_blink,if options.cursor_visible {1} else {0},color(p.foreground),color(p.background),color(p.cursor),color(p.selection));
    s.push_str("font-family = Noto Sans Mono CJK SC\nfont-family = Noto Sans Symbols 2\n");
    for feature in &options.font.features {
        s.push_str(&format!("font-feature = {feature}\n"));
    }
    let f = &options.font;
    s.push_str(&format!("adjust-cell-width = {}\nadjust-cell-height = {}%\nfont-style = {}\nfont-style-bold = {}\nminimum-contrast = {}\nbold-is-bright = {}\n",f.letter_spacing,f.extra_height_percent,if f.weight>=600 {"Bold"} else {"Regular"},if f.weight_bold>=600 {"Bold"} else {"Regular"},f.contrast as f64/100.,f.bold_is_bright));
    for (i, c) in p.ansi.iter().enumerate() {
        s.push_str(&format!("palette = {i}={}\n", color(*c)));
    }
    CString::new(s).unwrap()
}
enum Command {
    Output(u64, Vec<u8>),
    Barrier,
}
struct Completion {
    sequence: Option<u64>,
    success: bool,
}
struct FeedWorker {
    commands: Option<mpsc::SyncSender<Command>>,
    results: mpsc::Receiver<Completion>,
    join: Option<thread::JoinHandle<()>>,
    closing: Arc<AtomicBool>,
}
impl FeedWorker {
    fn new(handle: NonNull<c_void>, signal: Arc<core::WakeSignal>) -> Self {
        let (tx, rx) = mpsc::sync_channel(1);
        let (done_tx, done_rx) = mpsc::channel();
        let closing = Arc::new(AtomicBool::new(false));
        let stop = closing.clone();
        // Only this worker calls feed/barrier. It is joined before surface free.
        // The opaque pointer stays valid; no NSView dereference on this thread.
        let address = handle.as_ptr() as usize;
        let join = thread::spawn(move || {
            while let Ok(command) = rx.recv() {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let handle = address as *mut c_void;
                let (sequence, success) = unsafe {
                    match command {
                        Command::Output(seq, bytes) => {
                            let before = td_native_barrier(handle);
                            let feed = before
                                && (bytes.is_empty()
                                    || td_native_feed(handle, bytes.as_ptr(), bytes.len()));
                            (
                                Some(seq),
                                feed && td_native_drain_app(handle) && td_native_barrier(handle),
                            )
                        }
                        Command::Barrier => (
                            None,
                            td_native_drain_app(handle) && td_native_barrier(handle),
                        ),
                    }
                };
                if done_tx.send(Completion { sequence, success }).is_err() {
                    break;
                }
                signal.wake();
            }
        });
        Self {
            commands: Some(tx),
            results: done_rx,
            join: Some(join),
            closing,
        }
    }
    fn send(&self, command: Command) -> Result<(), Error> {
        self.commands
            .as_ref()
            .ok_or(Error::Closed)?
            .try_send(command)
            .map_err(|_| Error::Backpressure)
    }
    fn stop(&mut self) {
        self.closing.store(true, Ordering::Release);
        self.commands.take();
        if let Some(join) = self.join.take() {
            join.join().expect("Ghostty feed worker panicked");
        }
    }
}
struct ReplayProgress {
    records: VecDeque<ReplayRecord>,
    viewport_offset: usize,
}
pub enum SnapshotCapture {
    Captured(String),
    Unsafe,
    Unsupported,
    TooLarge,
}

pub struct NativePanel {
    handle: NonNull<c_void>,
    callbacks: Box<Callbacks>,
    worker: FeedWorker,
    envelope: Envelope,
    options: Options,
    font_size: f64,
    rect: Option<Rect>,
    busy: bool,
    ready: bool,
    replay: Option<ReplayProgress>,
    announced: bool,
    external_replay_end: bool,
    closed: bool,
    _main: PhantomData<Rc<()>>,
}
impl NativePanel {
    /// Fresh authoritative remote epoch only. Starting from an existing xterm's
    /// visible text is invalid; use create_from_replay with a complete journal.
    /// # Safety
    /// Parent is a live common-container NSView retained until drop, main thread.
    pub unsafe fn create(
        parent: NonNull<c_void>,
        options: Options,
        owner: Ownership,
        font_size: f64,
    ) -> Result<Self, NativeError> {
        main_thread()?;
        let envelope = Envelope::new(options.clone(), owner, font_size)?;
        let callbacks = Box::new(Callbacks {
            queue: EventQueue::default(),
            poisoned: AtomicBool::new(false),
            replaying: AtomicBool::new(false),
        });
        let text = config(&options, font_size);
        let ptr = td_native_create(
            parent.as_ptr(),
            (&*callbacks as *const Callbacks).cast_mut().cast(),
            receive,
            text.as_ptr(),
            font_size as f32,
            options.columns as u16,
            options.rows as u16,
            options.history.min(100_000) as u32,
        );
        let handle = NonNull::new(ptr).ok_or(NativeError::Initialization)?;
        let worker = FeedWorker::new(handle, callbacks.queue.wake.clone());
        let mut panel = Self {
            handle,
            callbacks,
            worker,
            envelope,
            options,
            font_size,
            rect: None,
            busy: false,
            ready: false,
            replay: None,
            announced: false,
            external_replay_end: true,
            closed: false,
            _main: PhantomData,
        };
        panel.start_barrier()?;
        Ok(panel)
    }
    /// Replays through the REAL Ghostty surface one record at a time. pump()
    /// produces Ready after reconstruction and suppressed query replies drain.
    /// # Safety
    /// Same main-thread NSView requirements as create.
    pub unsafe fn create_from_replay(
        parent: NonNull<c_void>,
        replay: Replay,
        owner: Ownership,
    ) -> Result<Self, NativeError> {
        Envelope::validate_replay(&replay, &owner)?;
        let mut panel = Self::create(parent, replay.initial, owner, replay.font_size)?;
        panel.callbacks.queue.drain(); // Initial geometry is not a remote resize.
        panel.callbacks.replaying.store(true, Ordering::Release);
        td_native_replaying(panel.handle.as_ptr(), true);
        panel.replay = Some(ReplayProgress {
            records: replay.records.into(),
            viewport_offset: replay.viewport_offset,
        });
        Ok(panel)
    }
    fn ensure_idle(&self) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        if self.busy
            || unsafe { td_native_is_busy(self.handle.as_ptr()) }
            || !self.ready
            || self.replay.is_some()
        {
            return Err(Error::Backpressure.into());
        }
        if self.callbacks.poisoned.load(Ordering::Acquire) {
            return Err(Error::EngineFailed.into());
        }
        Ok(())
    }
    fn start_barrier(&mut self) -> Result<(), NativeError> {
        unsafe {
            td_native_worker_busy(self.handle.as_ptr(), true);
        }
        if let Err(e) = self.worker.send(Command::Barrier) {
            self.close()?;
            return Err(e.into());
        }
        self.busy = true;
        self.announced = false;
        self.callbacks.queue.wake.wake();
        Ok(())
    }
    pub fn view_handle(&self) -> Result<NonNull<c_void>, NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        NonNull::new(unsafe { td_native_view(self.handle.as_ptr()) })
            .ok_or(NativeError::Initialization)
    }
    /// Read-only actual AppKit sibling/visibility/replay status; no pointers
    /// leave this scalar ABI or the page capability boundary.
    /// Bind only the actual page view supplied by the verified AppKit host.
    pub fn bind_webview(&mut self, wk:NonNull<c_void>)->Result<(),NativeError>{
        main_thread()?;if self.closed{return Err(Error::Closed.into());}
        if !unsafe{td_native_bind_webview(self.handle.as_ptr(),wk.as_ptr())}{return Err(NativeError::FocusTransfer);}
        Ok(())
    }
    pub fn attachment(&self,wk_view:NonNull<c_void>)->Result<u32,NativeError> {
        self.ensure_idle()?;
        Ok(unsafe {td_native_attachment(self.handle.as_ptr(),wk_view.as_ptr())})
    }
    pub fn render_stats(&self) -> Result<RenderStats, NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        let (mut attempts, mut submissions) = (0, 0);
        unsafe {
            td_native_render_stats(self.handle.as_ptr(), &mut attempts, &mut submissions);
        }
        Ok(RenderStats {
            attempts,
            submissions,
        })
    }
    pub fn geometry(&self, phase: u32) -> Result<Option<[f64; 16]>, NativeError> {
        self.ensure_idle()?;
        if phase > 2 { return Err(NativeError::Geometry); }
        let mut values = [0.; 16];
        if !unsafe { td_native_geometry(self.handle.as_ptr(), phase, values.as_mut_ptr()) } { return Ok(None); }
        if values.iter().any(|v| !v.is_finite()) { return Err(NativeError::Geometry); }
        Ok(Some(values))
    }
    pub fn window_geometry(wk_view: NonNull<c_void>) -> Result<[f64; 32], NativeError> {
        main_thread()?;
        let mut values = [0.; 32];
        if !unsafe { td_native_window_geometry(wk_view.as_ptr(), values.as_mut_ptr()) }
            || values.iter().any(|v| !v.is_finite()) { return Err(NativeError::Geometry); }
        Ok(values)
    }
    pub fn rebind_epoch(&mut self, owner: Ownership) -> Result<(), NativeError> {
        self.ensure_idle()?;
        self.envelope.rebind_epoch(owner)?;
        Ok(())
    }
    pub fn ownership(&self) -> &Ownership {
        self.envelope.ownership()
    }
    pub fn last_sequence(&self) -> u64 {
        self.envelope.last_sequence()
    }
    pub fn write(&mut self, sequence: u64, bytes: &[u8]) -> Result<Submission, NativeError> {
        self.write_internal(sequence,bytes,None)
    }
    fn write_internal(&mut self, sequence:u64, bytes:&[u8], replay:Option<(bool,bool)>) -> Result<Submission,NativeError> {
        main_thread()?;
        // Old consumed duplicates can be ACKed even with a new batch in flight.
        if let Submission::Duplicate(ack) = self.envelope.validate_write(sequence, bytes)? {
            return Ok(Submission::Duplicate(ack));
        }
        self.ensure_idle()?;
        let result = self.envelope.reserve(sequence, bytes)?;
        // Validation/reservation succeeded. Duplicates, gaps and oversized
        // batches above leave the current historical transaction untouched.
        let previous=(self.callbacks.replaying.load(Ordering::Acquire),self.external_replay_end);
        if let Some((replay,end))=replay {
            self.external_replay_end=!replay||end;
            self.callbacks.replaying.store(replay,Ordering::Release);
            unsafe {td_native_replaying(self.handle.as_ptr(),replay);}
        }
        unsafe {
            td_native_worker_busy(self.handle.as_ptr(), true);
        }
        if let Err(e) = self.worker.send(Command::Output(sequence, bytes.to_vec())) {
            self.envelope.cancel_reservation();
            self.external_replay_end=previous.1;
            self.callbacks.replaying.store(previous.0,Ordering::Release);
            unsafe {td_native_replaying(self.handle.as_ptr(),previous.0);}
            unsafe {
                td_native_worker_busy(self.handle.as_ptr(), false);
            }
            return Err(e.into());
        }
        self.busy = true;
        self.announced = false;
        self.callbacks.queue.wake.wake();
        Ok(result)
    }
    /// External authoritative backlog: suppress query responses through the IO
    /// barrier, including C callbacks and queued AppKit input. Never infer replay
    /// from text; the existing page protocol chooses this mode explicitly.
    pub fn write_with_replay(
        &mut self,
        sequence: u64,
        bytes: &[u8],
        replay: bool,
        end: bool,
    ) -> Result<Submission, NativeError> {
        self.write_internal(sequence,bytes,Some((replay,end)))
    }

    /// Capture is allowed only after the IO barrier, at an engine-verified
    /// safe parser/decoder/APC/DCS point. Unsupported/oversize keeps old cache.
    pub fn snapshot_options(&self) -> (Options, f64) {
        let mut options = self.options.clone();
        let (columns, rows) = self.dimensions();
        options.columns = columns;
        options.rows = rows;
        (options, self.font_size)
    }
    pub fn capture_snapshot(&self) -> Result<SnapshotCapture, NativeError> {
        self.ensure_idle()?;
        let mut bytes = vec![0u8; 128 * 1024];
        let mut len = 0;
        let status = unsafe {
            td_native_snapshot(
                self.handle.as_ptr(),
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len,
            )
        };
        match status {
            0 => {}
            1 => return Ok(SnapshotCapture::Unsafe),
            2 => return Ok(SnapshotCapture::Unsupported),
            3 => return Ok(SnapshotCapture::TooLarge),
            _ => return Err(Error::EngineFailed.into()),
        }
        if len > bytes.len() {
            return Err(Error::EngineFailed.into());
        }
        bytes.truncate(len);
        Ok(SnapshotCapture::Captured(
            String::from_utf8(bytes).map_err(|_| Error::EngineFailed)?,
        ))
    }
    /// Snapshot restore is a private local feed; it cannot write to the PTY.
    /// The internal replay barrier suppresses queries through final metadata.
    pub unsafe fn create_from_snapshot(
        parent: NonNull<c_void>,
        options: Options,
        owner: Ownership,
        font_size: f64,
        snapshot: String,
    ) -> Result<Self, NativeError> {
        if snapshot.len() > 128 * 1024 {
            return Err(Error::BatchTooLarge.into());
        }
        let value: serde_json::Value =
            serde_json::from_str(&snapshot).map_err(|_| Error::InvalidReplay)?;
        if value["version"] != 1 {
            return Err(Error::InvalidReplay.into());
        }
        let vt = value["vt"]
            .as_str()
            .ok_or(Error::InvalidReplay)?
            .as_bytes()
            .to_vec();
        if vt.len() > 128 * 1024 {
            return Err(Error::BatchTooLarge.into());
        }
        let mut panel = Self::create(parent, options, owner, font_size)?;
        panel.callbacks.queue.drain();
        panel.callbacks.replaying.store(true, Ordering::Release);
        td_native_replaying(panel.handle.as_ptr(), true);
        panel.replay = Some(ReplayProgress {
            records: VecDeque::from([ReplayRecord::Output {
                sequence: 1,
                bytes: vt,
            },ReplayRecord::SnapshotMetadata(snapshot)]),
            viewport_offset: 0,
        });
        Ok(panel)
    }
    pub fn set_waker(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        self.callbacks.queue.wake.set(listener);
        self.callbacks.queue.wake.wake();
    }
    pub fn confirm_checkpoint(&self, sequence: u64) -> Result<(), NativeError> {
        self.ensure_idle()?;
        if sequence != self.last_sequence() {
            return Err(Error::InvalidReplay.into());
        }
        Ok(())
    }
    pub fn set_scroll_policy(&mut self, tmux: bool) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        unsafe {
            td_native_policy(self.handle.as_ptr(), tmux);
        }
        Ok(())
    }
    pub fn set_link_hover(&mut self, revision:u64, rects:&[[f64;4]]) -> Result<bool,NativeError> {
        main_thread()?;if self.closed{return Err(Error::Closed.into());}
        if rects.len()>64{return Err(Error::Dimensions.into());}
        Ok(unsafe {td_native_link_hover(self.handle.as_ptr(),revision,rects.as_ptr().cast(),rects.len())})
    }
    pub fn set_history(&mut self, history: usize) -> Result<(), NativeError> {
        self.ensure_idle()?;
        self.envelope.history(history)?;
        unsafe {
            td_native_history(self.handle.as_ptr(), history as u32);
        }
        self.options.history = history;
        self.start_barrier()
    }
    pub fn dimensions(&self) -> (usize, usize) {
        self.envelope.dimensions()
    }
    pub fn cursor(&self) -> Result<(u32, u32), NativeError> {
        self.ensure_idle()?;
        let (mut x, mut y) = (0, 0);
        unsafe {
            td_native_cursor(self.handle.as_ptr(), &mut x, &mut y);
        }
        Ok((x, y))
    }
    pub fn blur(&mut self) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        let transferred=unsafe { td_native_blur(self.handle.as_ptr()) };
        self.callbacks.queue.wake.wake();
        if !transferred{return Err(NativeError::FocusTransfer);}
        Ok(())
    }
    pub fn action(&mut self, action: &str) -> Result<(), NativeError> {
        self.ensure_idle()?;
        if !["select_all", "scroll_to_bottom"].contains(&action) {
            return Err(NativeError::Geometry);
        }
        let text = CString::new(action).map_err(|_| NativeError::Geometry)?;
        if !unsafe { td_native_action(self.handle.as_ptr(), text.as_ptr(), action.len()) } {
            return Err(NativeError::Geometry);
        }
        self.start_barrier()
    }
    pub fn paste_text(&mut self, text: &str) -> Result<(), NativeError> {
        self.ensure_idle()?;
        if text.len() > core::MAX_BATCH_BYTES {
            return Err(Error::BatchTooLarge.into());
        }
        unsafe {
            td_native_text(self.handle.as_ptr(), text.as_ptr(), text.len());
        }
        self.start_barrier()
    }
    pub fn copy_text(&mut self, selection: bool) -> Result<CopyTextResult, NativeError> {
        self.ensure_idle()?;
        Ok(CopyTextResult::from_host(unsafe { td_native_read_text(self.handle.as_ptr(), selection) }))
    }
    pub fn set_font_size(&mut self, size: f64) -> Result<(), NativeError> {
        self.ensure_idle()?;
        if !size.is_finite() || !(1.0..=500.0).contains(&size) {
            return Err(NativeError::Geometry);
        }
        let text = config(&self.options, size);
        if !unsafe { td_native_palette(self.handle.as_ptr(), text.as_ptr()) } {
            return Err(Error::EngineFailed.into());
        }
        let (mut w, mut h, mut scale, mut cols, mut rows) = (0, 0, 1., 0, 0);
        unsafe {
            td_native_dimensions(
                self.handle.as_ptr(),
                &mut w,
                &mut h,
                &mut scale,
                &mut cols,
                &mut rows,
            );
        }
        self.envelope
            .font_size(size, cols as usize, rows as usize)?;
        self.font_size = size;
        self.start_barrier()
    }
    pub fn set_rect(&mut self, rect: Rect) -> Result<(), NativeError> {
        self.ensure_idle()?;
        if ![rect.x, rect.y, rect.width, rect.height, rect.scale]
            .iter()
            .all(|v| v.is_finite())
            || !(1.0..=4.0).contains(&rect.scale)
            || !(0.0..=32768.0).contains(&rect.width)
            || !(0.0..=32768.0).contains(&rect.height)
        {
            return Err(NativeError::Geometry);
        }
        if self.rect == Some(rect) {
            return Ok(());
        }
        let (mut cols, mut rows) = (0, 0);
        let result = unsafe {
            td_native_rect(
                self.handle.as_ptr(),
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                rect.scale,
                &mut cols,
                &mut rows,
            )
        };
        if result < 0 {
            self.close()?;
            return Err(Error::EngineFailed.into());
        }
        if result == 0 {
            return Err(NativeError::Geometry);
        }
        // C preflights exact Ghostty cell metrics BEFORE view/engine mutation.
        if rect.width > 0.0 && rect.height > 0.0 {
            if let Err(error) = self.envelope.resize(
                (rect.width * rect.scale).round() as u32,
                (rect.height * rect.scale).round() as u32,
                rect.scale,
                cols as usize,
                rows as usize,
            ) {
                self.close()?;
                return Err(error.into());
            }
        }
        self.rect = Some(rect);
        self.start_barrier()
    }
    /// Atomically update geometry, overlay mask and visibility on the AppKit
    /// main thread. Mask-only animation frames remain safe while output drains.
    pub fn set_layout(&mut self, rect: Rect, holes: &[[f64;4]], visible: bool) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed{return Err(Error::Closed.into());}
        if holes.len()>8192||![rect.x,rect.y,rect.width,rect.height,rect.scale].iter().all(|v|v.is_finite())||!(1.0..=4.0).contains(&rect.scale)||!(0.0..=32768.0).contains(&rect.width)||!(0.0..=32768.0).contains(&rect.height){return Err(NativeError::Geometry);}
        let resize=self.rect.is_none_or(|old|old.width!=rect.width||old.height!=rect.height||old.scale!=rect.scale);
        if resize {
            if let Err(error)=self.ensure_idle() {
                // An already-ready surface can follow the DOM immediately even
                // while output owns the engine. Its grid/cache remains unchanged
                // until the next successful set_layout and IO barrier.
                if matches!(&error,NativeError::Terminal(Error::Backpressure))
                    && self.ready && self.replay.is_none()
                    && !self.callbacks.poisoned.load(Ordering::Acquire)
                    && self.rect.is_some_and(|old|old.scale==rect.scale)
                    && unsafe{td_native_present_layout(self.handle.as_ptr(),rect.x,rect.y,rect.width,rect.height,holes.as_ptr().cast(),holes.len(),visible)}!=0 {
                    self.callbacks.queue.wake.wake();
                    return Err(NativeError::LayoutPending);
                }
                return Err(error);
            }
        }
        let (mut cols,mut rows)=(0,0);
        let result=unsafe{td_native_layout(self.handle.as_ptr(),rect.x,rect.y,rect.width,rect.height,rect.scale,holes.as_ptr().cast(),holes.len(),resize,visible,&mut cols,&mut rows)};
        if result<0{self.close()?;return Err(Error::EngineFailed.into());}
        if result==0{return Err(NativeError::Geometry);}
        if resize&&rect.width>0.0&&rect.height>0.0{
            if let Err(error)=self.envelope.resize((rect.width*rect.scale).round() as u32,(rect.height*rect.scale).round() as u32,rect.scale,cols as usize,rows as usize){self.close()?;return Err(error.into());}
        }
        self.rect=Some(rect);
        if resize{self.start_barrier()?;}else{self.callbacks.queue.wake.wake();}
        Ok(())
    }
    pub fn set_palette(&mut self, palette: Palette) -> Result<(), NativeError> {
        self.ensure_idle()?;
        let mut options = self.options.clone();
        options.palette = palette.clone();
        let text = config(&options, self.font_size);
        if !unsafe { td_native_palette(self.handle.as_ptr(), text.as_ptr()) } {
            self.close()?;
            return Err(Error::EngineFailed.into());
        }
        self.options = options;
        self.envelope.palette(palette);
        self.start_barrier()
    }
    pub fn set_cursor(&mut self, visible: bool, blink: bool) -> Result<(), NativeError> {
        self.ensure_idle()?;
        let mut options = self.options.clone();
        options.cursor_visible = visible;
        options.cursor_blink = blink;
        let text = config(&options, self.font_size);
        if !unsafe { td_native_palette(self.handle.as_ptr(), text.as_ptr()) } {
            self.close()?;
            return Err(Error::EngineFailed.into());
        }
        self.options = options;
        self.start_barrier()
    }
    pub fn set_font(&mut self, font: Font) -> Result<(), NativeError> {
        self.ensure_idle()?;
        font.validate()?;
        let mut options = self.options.clone();
        options.font = font.clone();
        let text = config(&options, self.font_size);
        if !unsafe { td_native_palette(self.handle.as_ptr(), text.as_ptr()) } {
            self.close()?;
            return Err(Error::EngineFailed.into());
        }
        let (mut w, mut h, mut scale, mut cols, mut rows) = (0, 0, 1., 0, 0);
        unsafe {
            td_native_dimensions(
                self.handle.as_ptr(),
                &mut w,
                &mut h,
                &mut scale,
                &mut cols,
                &mut rows,
            );
        }
        if let Err(error) = self.envelope.font(font, cols as usize, rows as usize) {
            self.close()?;
            return Err(error.into());
        }
        self.options = options;
        self.start_barrier()
    }
    pub fn focus(&mut self) -> Result<(), NativeError> {
        main_thread()?;
        defer_focus_intent(self.closed, self.callbacks.poisoned.load(Ordering::Acquire), || {
            // AppKit-owned desired state only. The existing idle pump applies
            // it after pending feed/replay/IO work; never start another barrier.
            unsafe { td_native_focus(self.handle.as_ptr()); }
            self.callbacks.queue.wake.wake();
        }).map_err(NativeError::from)
    }
    /// Hide is allowed while output is in flight; it only touches AppKit view.
    /// Engine occlusion/focus are deferred until the feed is idle.
    /// AppKit-only exclusion mask and hit-test holes; no engine lock, no
    /// second parser and no pause in hidden/occluded output consumption.
    pub fn set_input_blocked(&mut self, blocked:bool)->Result<(),NativeError>{
        main_thread()?;if self.closed{return Err(Error::Closed.into());}
        unsafe{td_native_input_blocked(self.handle.as_ptr(),blocked)};Ok(())
    }
    pub fn clip(&mut self, holes: &[[f64; 4]]) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        if holes.len() > 8192 {
            return Err(NativeError::Geometry);
        }
        if !unsafe { td_native_clip(self.handle.as_ptr(), holes.as_ptr().cast(), holes.len()) } {
            return Err(NativeError::Geometry);
        }
        Ok(())
    }
    pub fn set_visible(&mut self, visible: bool) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        let transferred=unsafe { td_native_visible(self.handle.as_ptr(), visible) };
        self.callbacks.queue.wake.wake();
        if !transferred{return Err(NativeError::FocusTransfer);}
        Ok(())
    }
    pub fn export_replay(&mut self) -> Result<Replay, NativeError> {
        self.ensure_idle()?;
        unsafe {
            td_native_flush_sync(self.handle.as_ptr());
        }
        self.envelope.flush_sync();
        Ok(self
            .envelope
            .export_replay(unsafe { td_native_viewport(self.handle.as_ptr()) })?)
    }
    pub fn search(&mut self, needle: &str, direction: i32) -> Result<SearchResult, NativeError> {
        self.ensure_idle()?;
        if needle.len() > 4096 || !(-1..=2).contains(&direction) {
            return Err(NativeError::Geometry);
        }
        let text = CString::new(needle).map_err(|_| NativeError::Geometry)?;
        let (mut total, mut selected) = (-1, -1);
        if unsafe {
            td_native_search(
                self.handle.as_ptr(),
                text.as_ptr(),
                needle.len(),
                direction,
                &mut total,
                &mut selected,
            )
        } == 0
        {
            return Err(Error::EngineFailed.into());
        }
        self.start_barrier()?;
        Ok(SearchResult { total, selected })
    }
    pub fn drain_events(&self) -> Vec<HostEvent> {
        self.callbacks.queue.drain()
    }
    pub fn pump(&mut self) -> Result<Vec<HostEvent>, NativeError> {
        main_thread()?;
        if self.closed {
            return Err(Error::Closed.into());
        }
        // Drain BEFORE any engine operation; never wait for worker from pump.
        let mut events = self.callbacks.queue.drain();
        if self.callbacks.poisoned.load(Ordering::Acquire) {
            self.close()?;
            events.extend(self.callbacks.queue.drain());
            if !events.iter().any(|e| matches!(e, HostEvent::Fatal(_))) {
                events.push(HostEvent::Fatal(
                    "Native callback capacity or engine health failed".into(),
                ));
            }
            return Ok(events);
        }
        if self.busy {
            unsafe {
                td_native_pump_io(self.handle.as_ptr());
            }
        }
        if let Ok(done) = self.worker.results.try_recv() {
            self.busy = false;
            unsafe {
                td_native_worker_busy(self.handle.as_ptr(), false);
            }
            if !done.success || self.callbacks.poisoned.load(Ordering::Acquire) {
                if let Some(seq) = done.sequence {
                    let _ = self.envelope.complete(seq, false);
                }
                self.close()?;
                events.extend(self.callbacks.queue.drain());
                events.push(HostEvent::Fatal(
                    "Ghostty consumption/barrier failed; same-session recovery required".into(),
                ));
                return Ok(events);
            }
            if done.sequence.is_some() && self.replay.is_none() && self.external_replay_end {
                unsafe {
                    td_native_replaying(self.handle.as_ptr(), false);
                }
                self.callbacks.replaying.store(false, Ordering::Release);
            }
            if let Some(seq) = done.sequence {
                let ack = self.envelope.complete(seq, true)?;
                if self.replay.is_none() {
                    events.push(HostEvent::Ack(ack));
                }
            }
            self.ready = true;
            events.extend(self.callbacks.queue.drain());
            if let Some(mut replay) = self.replay.take() {
                if let Some(record) = replay.records.pop_front() {
                    let result = (|| -> Result<(), NativeError> {
                        match record {
                            ReplayRecord::Output { sequence, bytes } => {
                                self.write(sequence, &bytes)?;
                            }
                            ReplayRecord::Size {
                                width_px,
                                height_px,
                                scale,
                                columns,
                                rows,
                            } => {
                                if !unsafe {
                                    td_native_replay_size(
                                        self.handle.as_ptr(),
                                        width_px,
                                        height_px,
                                        scale,
                                        columns as u16,
                                        rows as u16,
                                    )
                                } {
                                    return Err(NativeError::Geometry);
                                }
                                self.envelope
                                    .resize(width_px, height_px, scale, columns, rows)?;
                                self.start_barrier()?;
                            }
                            ReplayRecord::FlushSync => {
                                unsafe {
                                    td_native_flush_sync(self.handle.as_ptr());
                                }
                                self.envelope.flush_sync();
                                self.start_barrier()?;
                            }
                            ReplayRecord::Palette(palette) => {
                                self.set_palette(palette)?;
                            }
                            ReplayRecord::SnapshotMetadata(data) => {
                                if !unsafe {
                                    td_native_snapshot_finish(
                                        self.handle.as_ptr(),
                                        data.as_ptr(),
                                        data.len(),
                                    )
                                } {
                                    return Err(Error::InvalidReplay.into());
                                }
                                self.envelope.snapshot_metadata(data)?;
                                self.start_barrier()?;
                            }
                            ReplayRecord::History(history) => {
                                self.set_history(history)?;
                            }
                            ReplayRecord::FontSize {
                                size,
                                columns,
                                rows,
                            } => {
                                self.set_font_size(size)?;
                                if self.envelope.dimensions() != (columns, rows) {
                                    return Err(Error::InvalidReplay.into());
                                }
                            }
                            ReplayRecord::Font {
                                font,
                                columns,
                                rows,
                            } => {
                                self.set_font(font)?;
                                if self.envelope.dimensions() != (columns, rows) {
                                    return Err(Error::InvalidReplay.into());
                                }
                            }
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        return self.fail_events(events, &error.to_string());
                    }
                    self.replay = Some(replay);
                } else {
                    if !unsafe {
                        td_native_restore_viewport(self.handle.as_ptr(), replay.viewport_offset)
                    } {
                        return self.fail_events(
                            events,
                            "Ghostty replay viewport differs from checkpoint",
                        );
                    }
                    unsafe {
                        td_native_replaying(self.handle.as_ptr(), false);
                    }
                    self.callbacks.replaying.store(false, Ordering::Release);
                    let (columns, rows) = self.envelope.dimensions();
                    events.push(HostEvent::Resize { columns, rows });
                    self.announced = false;
                }
            }
        }
        if !self.busy && self.ready && self.replay.is_none() {
            // Handles AppKit event input, app wakeups, focus/occlusion changes.
            // It never calls draw/refresh on a host tick.
            let operation = unsafe { td_native_pump(self.handle.as_ptr()) };
            if operation < 0 {
                return self.fail_events(events, "Ghostty main-thread pump failed");
            }
            if operation > 0 {
                self.start_barrier()?;
            } else if !self.announced {
                self.announced = true;
                events.push(HostEvent::Ready);
            }
        }
        events.extend(self.callbacks.queue.drain());
        Ok(events)
    }
    fn fail_events(
        &mut self,
        mut events: Vec<HostEvent>,
        message: &str,
    ) -> Result<Vec<HostEvent>, NativeError> {
        self.close()?;
        events.extend(self.callbacks.queue.drain());
        events.push(HostEvent::Fatal(message.into()));
        Ok(events)
    }
    /// Stop new operations, wake blocked callbacks, join feed worker, then free
    /// Ghostty (joins its IO/renderer), remove NSView, release callback context.
    /// Drain events before close if the host must forward pending input.
    pub fn close(&mut self) -> Result<(), NativeError> {
        main_thread()?;
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        self.callbacks.queue.close();
        unsafe {
            td_native_cancel(self.handle.as_ptr());
        }
        self.worker.stop();
        unsafe {
            td_native_destroy(self.handle.as_ptr());
        }
        self.envelope.close();
        Ok(())
    }
}
impl Drop for NativePanel {
    fn drop(&mut self) {
        assert!(
            main_thread().is_ok(),
            "NativePanel dropped off AppKit thread"
        );
        let _ = self.close();
    }
}

#[cfg(test)]
mod cursor_config_tests {
    use super::*;

    #[test]
    fn cursor_visibility_and_blink_use_pinned_ghostty_config_keys() {
        let mut options = Options {
            font: Font::default(),
            columns: 80,
            rows: 24,
            history: 100,
            palette: Palette {
                ansi: [[0; 3]; 16],
                foreground: [1; 3],
                background: [0; 3],
                cursor: [1; 3],
                selection: [1; 3],
            },
            cursor_visible: false,
            cursor_blink: true,
        };
        let text = config(&options, 13.).to_string_lossy().into_owned();
        assert!(text.contains("cursor-style-blink = true\n"));
        assert!(text.contains("cursor-opacity = 0\n"));
        options.cursor_visible = true;
        options.cursor_blink = false;
        let text = config(&options, 13.).to_string_lossy().into_owned();
        assert!(text.contains("cursor-style-blink = false\n"));
        assert!(text.contains("cursor-opacity = 1\n"));
    }
}
