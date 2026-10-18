//! Real Ghostty/AppKit/Metal fixture. No shell, PTY, socket or credentials.
#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{ffi::c_void, ptr::NonNull};
    use termdock_native_terminal::{
        macos::{NativePanel, Rect},
        HostEvent, Options, Ownership, Palette,
    };
    extern "C" {
        fn td_native_demo_window() -> *mut c_void;
        fn td_native_demo_step(window: *mut c_void) -> i32;
        fn td_native_demo_close(window: *mut c_void);
        fn td_native_demo_parent(window: *mut c_void) -> *mut c_void;
        fn td_native_demo_bounds(window: *mut c_void, w: *mut f64, h: *mut f64, scale: *mut f64);
    }
    let palette: Palette = serde_json::from_slice(&std::fs::read(
        std::env::args()
            .nth(1)
            .ok_or("metal_fixture <palette.json> [raw-bytes]")?,
    )?)?;
    let raw = if let Some(path) = std::env::args().nth(2) {
        std::fs::read(path)?
    } else {
        "\x1b[2J\x1b[HGhostty full native engine / external backend\r\n中文宽字 😀 combining a\u{301} ligatures: != -> =>\r\n\x1b[31mANSI red\x1b[0m\r\nIME commits and query replies are logged below, never sent.\r\nCmd+C/V / mouse selection / Cmd+F search event. No local PTY.\r\n".as_bytes().to_vec()
    };
    let owner = Ownership {
        service: "fixture".into(),
        target: "fixture".into(),
        session: "no-pty".into(),
        device: "fixture".into(),
        window: "fixture".into(),
        view: "fixture".into(),
        epoch: "fresh".into(),
    };
    unsafe {
        let window = NonNull::new(td_native_demo_window()).ok_or("window failed")?;
        let parent = NonNull::new(td_native_demo_parent(window.as_ptr())).ok_or("parent failed")?;
        let mut panel = NativePanel::create(
            parent,
            Options {
                font: Default::default(),
                columns: 80,
                rows: 24,
                history: 1000,
                palette,
                cursor_visible: true,
                cursor_blink: true,
            },
            owner,
            14.,
        )?;
        let mut chunks = raw
            .chunks(termdock_native_terminal::core::MAX_BATCH_BYTES)
            .peekable();
        let mut next_seq = 1;
        let mut flight = false;
        let mut ready = false;
        let mut sized = false;
        let mut size = (0., 0., 0.);
        let mut stats_at = std::time::Instant::now();
        panel.set_visible(true)?;
        while td_native_demo_step(window.as_ptr()) != 0 {
            for event in panel.pump()? {
                match event {
                    HostEvent::Ready => ready = true,
                    HostEvent::Ack(ack) => {
                        eprintln!("consumed: {ack:?}");
                        flight = false;
                    }
                    HostEvent::Input(bytes) => eprintln!("input/query bytes: {bytes:?}"),
                    HostEvent::SearchRequested(_) => {
                        eprintln!("search request (fixture search 'Ghostty')");
                        let _ = panel.search("Ghostty", 0);
                    }
                    HostEvent::Fatal(reason) => return Err(reason.into()),
                    other => eprintln!("{other:?}"),
                }
            }
            if stats_at.elapsed() >= std::time::Duration::from_secs(1) {
                eprintln!("real renderer counters: {:?}", panel.render_stats()?);
                stats_at = std::time::Instant::now();
            }
            if !ready || flight {
                continue;
            }
            let (mut w, mut h, mut scale) = (0., 0., 0.);
            td_native_demo_bounds(window.as_ptr(), &mut w, &mut h, &mut scale);
            if size != (w, h, scale) {
                if panel
                    .set_rect(Rect {
                        x: 0.,
                        y: 0.,
                        width: w,
                        height: h,
                        scale,
                    })
                    .is_ok()
                {
                    size = (w, h, scale);
                    sized = true;
                }
                continue;
            }
            if sized {
                if let Some(bytes) = chunks.peek() {
                    if panel.write(next_seq, bytes).is_ok() {
                        chunks.next();
                        next_seq += 1;
                        flight = true;
                    }
                }
            }
        }
        panel.close()?;
        drop(panel);
        td_native_demo_close(window.as_ptr());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Requires the locked full Ghostty library and real AppKit/Metal on macOS.");
}
