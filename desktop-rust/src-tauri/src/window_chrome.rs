//! Default-off owned window observations. No native actions or business transport.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Instant,
};
use tauri::WebviewWindow;

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Role {
    Center,
    Service,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TitlebarDoubleClickAction { Zoom, Minimize, None }
pub(crate) fn titlebar_double_click_action(value: Option<&str>) -> TitlebarDoubleClickAction {
    titlebar_double_click_preference(value).0
}
pub(crate) fn titlebar_double_click_preference(value: Option<&str>) -> (TitlebarDoubleClickAction, bool) {
    match value.map(str::trim) {
        Some("Minimize") => (TitlebarDoubleClickAction::Minimize, true),
        Some("None") => (TitlebarDoubleClickAction::None, true),
        Some("Zoom") | None => (TitlebarDoubleClickAction::Zoom, true),
        Some(_) => (TitlebarDoubleClickAction::None, false),
    }
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PagePhase {
    Hit,
    RequestStart,
    RequestEnd,
    Budget,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Hit {
    RailTop,
    Brand,
    CenterTopbar,
    WindowHeader,
    Widget,
    Control,
    Body,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Outcome {
    Resolved,
    Rejected,
}
#[derive(Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Observation {
    owner_generation: u64,
    document_generation: u64,
    index: u32,
    phase: PagePhase,
    hit: Option<Hit>,
    button: Option<u8>,
    trusted: Option<bool>,
    prevented: Option<bool>,
    eligible: Option<bool>,
    x_css_px: Option<f64>,
    y_css_px: Option<f64>,
    request_index: Option<u32>,
    outcome: Option<Outcome>,
}
impl Observation {
    fn valid(&self) -> bool {
        if self.index == 0 || self.index > 32 {
            return false;
        }
        match self.phase {
            PagePhase::Budget => {
                self.index == 32
                    && self.request_index.is_none()
                    && self.outcome.is_none()
                    && self.hit.is_none()
                    && self.button.is_none()
                    && self.trusted.is_none()
                    && self.prevented.is_none()
                    && self.eligible.is_none()
                    && self.x_css_px.is_none()
                    && self.y_css_px.is_none()
            }
            PagePhase::Hit => {
                self.hit.is_some()
                    && self.button.is_some_and(|v| v <= 2)
                    && self.trusted.is_some()
                    && self.prevented.is_some()
                    && self.eligible.is_some()
                    && [self.x_css_px, self.y_css_px]
                        .iter()
                        .all(|v| v.is_some_and(|n| n.is_finite() && n.abs() <= 32768.))
                    && self.request_index.is_none()
                    && self.outcome.is_none()
            }
            PagePhase::RequestStart | PagePhase::RequestEnd => {
                self.request_index.is_some_and(|v| v > 0 && v <= 32)
                    && self.hit.is_none()
                    && self.button.is_none()
                    && self.trusted.is_none()
                    && self.prevented.is_none()
                    && self.eligible.is_none()
                    && self.x_css_px.is_none()
                    && self.y_css_px.is_none()
                    && matches!(
                        (self.phase, self.outcome),
                        (PagePhase::RequestStart, None) | (PagePhase::RequestEnd, Some(_))
                    )
            }
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ButtonSnapshot {
    present: u32,
    flags: u32,
    rects: [[f64; 4]; 6],
    center_top_wk: f64,
    border_width: [f64; 2],
    background_alpha: [f64; 2],
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ButtonGeometry {
    present: u32,
    flags: u32,
    button_in_wk_pt: Option<[f64; 4]>,
    parent_bounds_pt: Option<[f64; 4]>,
    parent_frame_in_grandparent_pt: Option<[f64; 4]>,
    grandparent_in_wk_pt: Option<[f64; 4]>,
    grandparent_in_window_pt: Option<[f64; 4]>,
    button_frame_in_parent_pt: Option<[f64; 4]>,
    center_top_wk_pt: Option<f64>,
    parent_border_width_pt: Option<f64>,
    grandparent_border_width_pt: Option<f64>,
    parent_background_alpha: Option<f64>,
    grandparent_background_alpha: Option<f64>,
}
impl ButtonSnapshot {
    fn checked(self) -> Option<ButtonGeometry> {
        if self.present & !0x7ff != 0 || self.flags & !0x1ff != 0 {
            return None;
        }
        let mut rects = [None; 6];
        for (i, rect) in self.rects.iter().enumerate() {
            if self.present & (1 << i) != 0 {
                if !rect.iter().all(|v| v.is_finite() && v.abs() <= 1e7)
                    || rect[2] < 0.
                    || rect[3] < 0.
                {
                    return None;
                }
                rects[i] = Some(*rect);
            }
        }
        let scalar = |bit: u32, value: f64, low: f64, high: f64| -> Option<Option<f64>> {
            if self.present & (1 << bit) == 0 {
                Some(None)
            } else if value.is_finite() && (low..=high).contains(&value) {
                Some(Some(value))
            } else {
                None
            }
        };
        Some(ButtonGeometry {
            present: self.present,
            flags: self.flags,
            button_in_wk_pt: rects[0],
            parent_bounds_pt: rects[1],
            parent_frame_in_grandparent_pt: rects[2],
            grandparent_in_wk_pt: rects[3],
            grandparent_in_window_pt: rects[4],
            button_frame_in_parent_pt: rects[5],
            center_top_wk_pt: scalar(6, self.center_top_wk, -1e7, 1e7)?,
            parent_border_width_pt: scalar(7, self.border_width[0], 0., 1e7)?,
            grandparent_border_width_pt: scalar(8, self.border_width[1], 0., 1e7)?,
            parent_background_alpha: scalar(9, self.background_alpha[0], 0., 1.)?,
            grandparent_background_alpha: scalar(10, self.background_alpha[1], 0., 1.)?,
        })
    }
}
const _: () = assert!(std::mem::size_of::<ButtonSnapshot>() == 240);
// Exact stack POD shared with native/window_chrome.h; no text allocation/free ABI.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct Snapshot {
    present: u32,
    role: u32,
    flags: u32,
    event_type: u32,
    owner_generation: u64,
    document_generation: u64,
    backing_scale: f64,
    rects: [[f64; 4]; 9],
    buttons: [ButtonSnapshot; 3],
}
const _: () = assert!(std::mem::size_of::<Snapshot>() == 1048);
const _: () = assert!(std::mem::align_of::<Snapshot>() == 8);
const _: () = assert!(std::mem::offset_of!(Snapshot, rects) == 40);
const _: () = assert!(std::mem::offset_of!(Snapshot, buttons) == 328);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Geometry {
    present: u32,
    role: u32,
    flags: u32,
    event_type: Option<u32>,
    backing_scale: Option<f64>,
    appkit_window_screen_bottom_left_pt: Option<[f64; 4]>,
    content_layout_window_pt: Option<[f64; 4]>,
    content_frame_parent_pt: Option<[f64; 4]>,
    content_bounds_pt: Option<[f64; 4]>,
    wk_frame_parent_pt: Option<[f64; 4]>,
    wk_bounds_pt: Option<[f64; 4]>,
    wk_in_content_pt: Option<[f64; 4]>,
    wk_in_window_pt: Option<[f64; 4]>,
    button_container_frame_parent_pt: Option<[f64; 4]>,
    standard_buttons: [ButtonGeometry; 3],
}
impl Snapshot {
    fn checked(self) -> Option<Geometry> {
        if self.present & !0xfff != 0 || self.flags & !0x1ff != 0 || self.role > 3 {
            return None;
        }
        let mut r = [None; 9];
        for (i, rect) in self.rects.iter().enumerate() {
            if self.present & (1 << i) != 0 {
                if !rect.iter().all(|v| v.is_finite() && v.abs() <= 1e7)
                    || rect[2] < 0.
                    || rect[3] < 0.
                {
                    return None;
                }
                r[i] = Some(*rect);
            }
        }
        let backing = if self.present & (1 << 9) != 0 {
            if !self.backing_scale.is_finite() || !(0.5..=8.).contains(&self.backing_scale) {
                return None;
            }
            Some(self.backing_scale)
        } else {
            None
        };
        let event = if self.present & (1 << 10) != 0 {
            if self.event_type > 1024 {
                return None;
            }
            Some(self.event_type)
        } else {
            None
        };
        Some(Geometry {
            present: self.present,
            role: self.role,
            flags: self.flags,
            event_type: event,
            backing_scale: backing,
            appkit_window_screen_bottom_left_pt: r[0],
            content_layout_window_pt: r[1],
            content_frame_parent_pt: r[2],
            content_bounds_pt: r[3],
            wk_frame_parent_pt: r[4],
            wk_bounds_pt: r[5],
            wk_in_content_pt: r[6],
            wk_in_window_pt: r[7],
            button_container_frame_parent_pt: r[8],
            standard_buttons: [
                self.buttons[0].checked()?,
                self.buttons[1].checked()?,
                self.buttons[2].checked()?,
            ],
        })
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
enum HostPhase {
    Initial,
    PageFinished,
    AlignmentBefore,
    AlignmentAfter,
    DragCommandBoundary,
    DragEnqueueOk,
    DragEnqueueRejected,
    CallerRejected,
    MovedCandidate,
    OtherMoved,
    Invalidated,
}
#[derive(Clone, Serialize)]
#[serde(tag = "source", rename_all = "kebab-case")]
enum Data {
    Page {
        observation: Observation,
    },
    Host {
        phase: HostPhase,
        request_index: Option<u32>,
        geometry: Option<Geometry>,
        pair_id: Option<u64>,
        pair_expected: Option<u8>,
        tauri_outer_screen_top_left_pt: Option<[f64; 4]>,
        elapsed_ms: Option<u64>,
    },
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    index: u64,
    owner: Role,
    owner_generation: u64,
    document_generation: u64,
    monotonic_ms: u64,
    data: Data,
}
struct Pending {
    index: u32,
    started: Instant,
}
struct Reservation {
    expected: u8,
    left: u8,
}
struct Owner {
    label: String,
    role: Role,
    instance: u64,
    document: u64,
    alive: bool,
    samples_left: u8,
    page_left: u8,
    last_page_index: u32,
    reservations: BTreeMap<u64, Reservation>,
    pending: Option<Pending>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentCounts {
    owner: Role,
    owner_generation: u64,
    document_generation: u64,
    schedule_requests: u32,
    batch_writes: u32,
    containment_rejections: u32,
    saturated: bool,
}
#[derive(Default)]
struct State {
    owners: Vec<Owner>,
    ring: VecDeque<Record>,
    count: u64,
    dropped: u64,
    truncated: bool,
    cancelled_samples: u64,
    persist_failed: bool,
    next_pair: u64,
    revision: u64,
    finalizing: bool,
    alignment_counts: BTreeMap<u64, AlignmentCounts>,
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
// Process-global monotonically allocated instances, never reset/reused by label/doc.
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);
static CLOCK: OnceLock<Instant> = OnceLock::new();
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(Default::default)
}
fn elapsed() -> u64 {
    CLOCK
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn record(s: &mut State, slot: usize, data: Data) {
    let o = &s.owners[slot];
    let (role, instance, document) = (o.role, o.instance, o.document);
    s.count += 1;
    if s.ring.len() == 32 {
        s.ring.pop_front();
        s.dropped += 1;
        s.truncated = true;
    }
    s.ring.push_back(Record {
        index: s.count,
        owner: role,
        owner_generation: instance,
        document_generation: document,
        monotonic_ms: elapsed(),
        data,
    });
}
fn host(phase: HostPhase, request_index: Option<u32>) -> Data {
    Data::Host {
        phase,
        request_index,
        geometry: None,
        pair_id: None,
        pair_expected: None,
        tauri_outer_screen_top_left_pt: None,
        elapsed_ms: None,
    }
}
fn clear_pending(s: &mut State, slot: usize) {
    let o = &mut s.owners[slot];
    o.pending = None;
    s.cancelled_samples += o.reservations.values().map(|r| r.left as u64).sum::<u64>();
    o.reservations.clear();
}
#[derive(Default)]
struct Persist {
    revision: u64,
    finalized: bool,
}
static PERSIST: OnceLock<Mutex<Persist>> = OnceLock::new();
impl Persist {
    fn write(
        &mut self,
        path: &std::path::Path,
        revision: u64,
        finalized: bool,
        bytes: &[u8],
    ) -> std::io::Result<()> {
        if revision <= self.revision || self.finalized {
            return Ok(());
        }
        // One writer, same-directory replacement. A failed write never truncates the previous report.
        let temporary = path.with_extension("json.pending");
        let result = (|| {
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result?;
        self.revision = revision;
        self.finalized = finalized;
        Ok(())
    }
}
pub(crate) fn flush() {
    let _ = flush_report(false);
}
pub(crate) fn flush_final() -> bool {
    flush_report(true)
}
fn flush_report(finalized: bool) -> bool {
    let (
        revision,
        count,
        records,
        dropped,
        truncated,
        cancelled,
        incomplete,
        persist_failed,
        alignment_counts,
    ) = {
        let Ok(mut s) = state().lock() else {
            return false;
        };
        if s.finalizing && !finalized {
            return true;
        }
        s.finalizing |= finalized;
        // Captured state revisions are assigned under STATE, including captures
        // containing only budget/cancellation changes. Final capture seals publication.
        let Some(revision) = s.revision.checked_add(1) else {
            return false;
        };
        s.revision = revision;
        (
            revision,
            s.count,
            s.ring.clone(),
            s.dropped,
            s.truncated,
            s.cancelled_samples,
            s.owners
                .iter()
                .flat_map(|o| o.reservations.values())
                .filter(|r| r.expected == 2 && r.left > 0)
                .count(),
            s.persist_failed,
            s.alignment_counts.values().cloned().collect::<Vec<_>>(),
        )
    };
    let report = serde_json::json!({"version":1,"stateRevision":revision,"recordIndex":count,
        "finalized":finalized,"pendingVisibleGesture":true,"nativeMovementPassed":false,
        "alignmentCounters":alignment_counts,"records":records,"dropped":dropped,"truncated":truncated,
        "cancelledSamples":cancelled,"incompletePairs":incomplete,"persistFailed":persist_failed});
    // Neither serialization nor filesystem I/O holds STATE; callbacks never wait on I/O.
    let result = (|| {
        let bytes = serde_json::to_vec(&report).ok()?;
        if bytes.len() > 64 * 1024 {
            return None;
        }
        let path = crate::native_gate::chrome_path()?;
        let mut writer = PERSIST.get_or_init(Default::default).lock().ok()?;
        writer
            .write(&path, report["stateRevision"].as_u64()?, finalized, &bytes)
            .ok()
    })()
    .is_some();
    if !result {
        if let Ok(mut s) = state().lock() {
            s.persist_failed = true;
            s.truncated = true;
        }
    }
    result
}

fn slot(s: &State, label: &str) -> Option<usize> {
    s.owners.iter().position(|o| o.label == label && o.alive)
}
fn binding(window: &WebviewWindow) -> Option<(u64, u64)> {
    let s = state().lock().ok()?;
    let o = &s.owners[slot(&s, window.label())?];
    Some((o.instance, o.document))
}
pub(crate) fn enabled() -> bool {
    crate::native_gate::chrome_enabled()
}
fn allocate_instance() -> Option<u64> {
    NEXT_INSTANCE
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
        .ok()
}
pub(crate) fn new_instance() -> Option<u64> {
    if !enabled() {
        return None;
    }
    allocate_instance()
}
fn ensure(window: &WebviewWindow, expected: Option<u64>) -> Option<u64> {
    let instance = expected?;
    let role = crate::native_gate::chrome_role(window, false)?;
    let mut s = state().lock().ok()?;
    if let Some(i) = s.owners.iter().position(|o| o.label == window.label()) {
        if s.owners[i].instance == instance {
            return s.owners[i].alive.then_some(instance);
        }
        if s.owners[i].instance > instance {
            return None;
        }
        clear_pending(&mut s, i);
        s.owners[i] = Owner {
            label: window.label().into(),
            role,
            instance,
            document: 0,
            alive: true,
            samples_left: 8,
            page_left: 32,
            last_page_index: 0,
            reservations: BTreeMap::new(),
            pending: None,
        };
    } else if s.owners.len() < 2 {
        s.owners.push(Owner {
            label: window.label().into(),
            role,
            instance,
            document: 0,
            alive: true,
            samples_left: 8,
            page_left: 32,
            last_page_index: 0,
            reservations: BTreeMap::new(),
            pending: None,
        });
    } else {
        s.truncated = true;
        return None;
    }
    Some(instance)
}
fn current(window: &WebviewWindow, expected: Option<u64>) -> bool {
    binding(window).is_some_and(|(instance, _)| Some(instance) == expected)
}
pub(crate) fn created(window: &WebviewWindow, expected: Option<u64>) {
    if ensure(window, expected).is_some() {
        sample(window, 0, expected);
    }
}
pub(crate) fn page_started(window: &WebviewWindow, expected: Option<u64>) {
    if ensure(window, expected).is_none() {
        return;
    }
    invalidate_instance(window, true, expected);
    configure(window, None, expected);
}
pub(crate) fn page_finished(window: &WebviewWindow, expected: Option<u64>) {
    if ensure(window, expected).is_none() {
        return;
    }
    sample(window, 1, expected);
    let Some((instance, document)) =
        binding(window).filter(|(instance, _)| Some(*instance) == expected)
    else {
        return;
    };
    // Outside with_webview and registry locks. Old docs cannot overwrite newer attachment stamps.
    let script=format!("window.dispatchEvent(new CustomEvent('termdock:owned-window-chrome',{{detail:{{ownerGeneration:{instance},documentGeneration:{document}}}}}));");
    if binding(window) == Some((instance, document)) {
        let _ = window.eval(&script);
    }
}
pub(crate) fn invalidate(window: &WebviewWindow, navigation: bool) {
    let expected = binding(window).map(|b| b.0);
    invalidate_instance(window, navigation, expected);
}
pub(crate) fn invalidate_instance(window: &WebviewWindow, navigation: bool, expected: Option<u64>) {
    if !enabled() || !current(window, expected) {
        return;
    }
    let Ok(mut s) = state().lock() else { return };
    let Some(i) = slot(&s, window.label()) else {
        return;
    };
    if Some(s.owners[i].instance) != expected {
        return;
    }
    clear_pending(&mut s, i);
    if navigation {
        if let Some(next) = s.owners[i].document.checked_add(1) {
            s.owners[i].document = next;
            s.owners[i].last_page_index = 0;
        } else {
            s.owners[i].alive = false;
        }
    }
    record(&mut s, i, host(HostPhase::Invalidated, None));
    drop(s);
    flush();
}
pub(crate) fn destroyed(label: &str, expected: Option<u64>) {
    if !enabled() {
        return;
    }
    if let Ok(mut s) = state().lock() {
        if let Some(i) = slot(&s, label) {
            if Some(s.owners[i].instance) == expected {
                clear_pending(&mut s, i);
                s.owners[i].alive = false;
            }
        }
    }
    flush();
}
pub(crate) fn observe(
    window: &WebviewWindow,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !enabled() {
        return Err("Owned window observations unavailable".into());
    }
    if crate::native_gate::chrome_role(window, true).is_none() {
        return Err("Owned window observation context rejected".into());
    }
    let value: Observation =
        serde_json::from_value(args).map_err(|_| "Invalid owned window observation")?;
    if !value.valid() {
        return Err("Invalid owned window observation fields".into());
    }
    let mut s = state()
        .lock()
        .map_err(|_| "Owned window observations unavailable")?;
    let i = slot(&s, window.label()).ok_or("Owned window instance absent")?;
    let o = &mut s.owners[i];
    if (value.owner_generation, value.document_generation) != (o.instance, o.document)
        || value.index <= o.last_page_index
    {
        return Err("Stale owned window observation".into());
    }
    if o.page_left == 0 {
        s.truncated = true;
        drop(s);
        flush();
        return Err("Owned window observation budget exhausted".into());
    }
    o.page_left -= 1;
    o.last_page_index = value.index;
    if matches!(value.phase, PagePhase::Budget) {
        s.truncated = true;
    }
    record(&mut s, i, Data::Page { observation: value });
    drop(s);
    flush();
    Ok(serde_json::json!({"accepted":true}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DragStamp {
    owner_generation: u64,
    document_generation: u64,
    request_index: u32,
}
pub(crate) fn drag_start(
    window: &WebviewWindow,
    args: &serde_json::Value,
) -> Option<(u64, u64, u32)> {
    if !enabled() || crate::native_gate::chrome_role(window, true).is_none() {
        return None;
    }
    let stamp: DragStamp = serde_json::from_value(args.get("ownedWindowChrome")?.clone()).ok()?;
    if !(1..=32).contains(&stamp.request_index) {
        return None;
    }
    let mut s = state().lock().ok()?;
    let i = slot(&s, window.label())?;
    let o = &mut s.owners[i];
    if (o.instance, o.document) != (stamp.owner_generation, stamp.document_generation) {
        return None;
    }
    o.pending = Some(Pending {
        index: stamp.request_index,
        started: Instant::now(),
    });
    record(
        &mut s,
        i,
        host(HostPhase::DragCommandBoundary, Some(stamp.request_index)),
    );
    drop(s);
    Some((
        stamp.owner_generation,
        stamp.document_generation,
        stamp.request_index,
    ))
}
fn complete_drag(s: &mut State, label: &str, stamp: (u64, u64, u32), ok: bool) {
    let (instance, document, index) = stamp;
    let Some(i) = slot(s, label) else { return };
    if (s.owners[i].instance, s.owners[i].document) != (instance, document) {
        return;
    }
    if !ok
        && s.owners[i]
            .pending
            .as_ref()
            .is_some_and(|p| p.index == index)
    {
        s.owners[i].pending = None;
    }
    record(
        s,
        i,
        host(
            if ok {
                HostPhase::DragEnqueueOk
            } else {
                HostPhase::DragEnqueueRejected
            },
            Some(index),
        ),
    );
}
pub(crate) fn drag_end(window: &WebviewWindow, stamp: Option<(u64, u64, u32)>, ok: bool) {
    let Some(stamp) = stamp else { return };
    let Ok(mut s) = state().lock() else { return };
    complete_drag(&mut s, window.label(), stamp, ok);
    drop(s);
    flush();
}
pub(crate) fn caller_rejected(window: &WebviewWindow) {
    if !enabled() {
        return;
    }
    if let Ok(mut s) = state().lock() {
        if let Some(i) = slot(&s, window.label()) {
            record(&mut s, i, host(HostPhase::CallerRejected, None));
        }
    }
    flush();
}
fn matches_stamp(s: &State, i: usize, captured: (u64, u64)) -> bool {
    let o = &s.owners[i];
    o.alive && (o.instance, o.document) == captured
}
pub(crate) fn moved(window: &WebviewWindow, expected: Option<u64>) {
    if !enabled() || !current(window, expected) {
        return;
    }
    let Some(captured) = binding(window).filter(|(instance, _)| Some(*instance) == expected) else {
        return;
    };
    if window.is_fullscreen().unwrap_or(true) {
        invalidate_instance(window, false, expected);
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    if !scale.is_finite() || !(0.5..=8.).contains(&scale) {
        return;
    }
    let frame = [
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ];
    let Ok(mut s) = state().lock() else { return };
    record_moved(&mut s, window.label(), captured, frame);
    drop(s);
    flush();
}
fn record_moved(s: &mut State, label: &str, captured: (u64, u64), frame: [f64; 4]) {
    let Some(i) = slot(s, label) else { return };
    if !matches_stamp(s, i, captured) {
        return;
    }
    let candidate = s.owners[i]
        .pending
        .as_ref()
        .filter(|p| p.started.elapsed().as_millis() <= 2000)
        .map(|p| (p.index, p.started.elapsed().as_millis() as u64));
    record(
        s,
        i,
        Data::Host {
            phase: if candidate.is_some() {
                HostPhase::MovedCandidate
            } else {
                HostPhase::OtherMoved
            },
            request_index: candidate.map(|p| p.0),
            geometry: None,
            pair_id: None,
            pair_expected: None,
            tauri_outer_screen_top_left_pt: Some(frame),
            elapsed_ms: candidate.map(|p| p.1),
        },
    );
}

fn accept_counts(
    s: &mut State,
    instance: u64,
    document: u64,
    schedules: u32,
    writes: u32,
    rejects: u32,
    saturated: u32,
) {
    if schedules > 65535 || writes > 65535 || rejects > 65535 || saturated > 1 {
        return;
    }
    let Some(owner) = s
        .owners
        .iter()
        .find(|o| o.alive && o.instance == instance && o.document == document)
    else {
        return;
    };
    let role = owner.role;
    if s.alignment_counts.get(&instance).is_some_and(|old| {
        old.schedule_requests > schedules
            || old.batch_writes > writes
            || old.containment_rejections > rejects
            || (old.saturated && saturated == 0)
    }) {
        return;
    }
    s.alignment_counts
        .retain(|key, _| s.owners.iter().any(|o| o.instance == *key));
    s.alignment_counts.insert(
        instance,
        AlignmentCounts {
            owner: role,
            owner_generation: instance,
            document_generation: document,
            schedule_requests: schedules,
            batch_writes: writes,
            containment_rejections: rejects,
            saturated: saturated == 1,
        },
    );
}
extern "C" fn counts(
    instance: u64,
    document: u64,
    schedules: u32,
    writes: u32,
    rejects: u32,
    saturated: u32,
) {
    if let Ok(mut s) = state().lock() {
        accept_counts(
            &mut s, instance, document, schedules, writes, rejects, saturated,
        );
    }
}
extern "C" fn reserve(instance: u64, document: u64, count: u32) -> u64 {
    if count != 1 && count != 2 {
        return 0;
    }
    let Ok(mut s) = state().lock() else { return 0 };
    let Some(i) = s
        .owners
        .iter()
        .position(|o| o.alive && o.instance == instance && o.document == document)
    else {
        return 0;
    };
    if s.owners[i].samples_left < count as u8 {
        s.truncated = true;
        return 0;
    }
    let Some(ticket) = s.next_pair.checked_add(1) else {
        return 0;
    };
    s.next_pair = ticket;
    s.owners[i].samples_left -= count as u8;
    s.owners[i].reservations.insert(
        ticket,
        Reservation {
            expected: count as u8,
            left: count as u8,
        },
    );
    ticket
}
extern "C" fn receive(ticket: u64, phase: u32, pod: *const Snapshot) {
    if pod.is_null() || phase > 3 {
        return;
    }
    let value = unsafe { *pod };
    let Some(geometry) = value.checked() else {
        return;
    };
    let Ok(mut s) = state().lock() else { return };
    let Some(i) = s.owners.iter().position(|o| {
        o.alive && o.instance == value.owner_generation && o.document == value.document_generation
    }) else {
        return;
    };
    let Some(reservation) = s.owners[i].reservations.get_mut(&ticket) else {
        return;
    };
    if reservation.left == 0 {
        return;
    }
    let expected = reservation.expected;
    if (expected == 2
        && ((reservation.left == 2 && phase != 2) || (reservation.left == 1 && phase != 3)))
        || (expected == 1 && matches!(phase, 2 | 3))
    {
        return;
    }
    reservation.left -= 1;
    if reservation.left == 0 {
        s.owners[i].reservations.remove(&ticket);
    }
    let phase = match phase {
        0 => HostPhase::Initial,
        1 => HostPhase::PageFinished,
        2 => HostPhase::AlignmentBefore,
        3 => HostPhase::AlignmentAfter,
        _ => return,
    };
    let request_index = s.owners[i].pending.as_ref().map(|p| p.index);
    record(
        &mut s,
        i,
        Data::Host {
            phase,
            request_index,
            geometry: Some(geometry),
            pair_id: Some(ticket),
            pair_expected: Some(expected),
            tauri_outer_screen_top_left_pt: None,
            elapsed_ms: None,
        },
    );
}
fn sample(window: &WebviewWindow, phase: u32, expected: Option<u64>) {
    configure(window, Some(phase), expected);
}
fn configure(window: &WebviewWindow, phase: Option<u32>, expected: Option<u64>) {
    let Some((instance, document)) =
        binding(window).filter(|(instance, _)| Some(*instance) == expected)
    else {
        return;
    };
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(move |webview| unsafe {
            // Main-thread native read/config only. No window message/eval under WK lock.
            let valid = state().lock().ok().is_some_and(|s| {
                s.owners
                    .iter()
                    .any(|o| o.alive && o.instance == instance && o.document == document)
            });
            if !valid {
                return;
            }
            extern "C" {
                fn td_preview_window_chrome(
                    wk: *mut std::ffi::c_void,
                    instance: u64,
                    document: u64,
                    phase: u32,
                    reserve: extern "C" fn(u64, u64, u32) -> u64,
                    receive: extern "C" fn(u64, u32, *const Snapshot),
                    counts: extern "C" fn(u64, u64, u32, u32, u32, u32),
                );
            }
            td_preview_window_chrome(
                webview.inner().cast(),
                instance,
                document,
                phase.unwrap_or(u32::MAX),
                reserve,
                receive,
                counts,
            );
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (instance, document, phase);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn titlebar_double_click_obeys_the_appkit_user_default_and_keeps_zoom_separate_from_fullscreen() {
        assert_eq!(titlebar_double_click_action(Some("Zoom")),TitlebarDoubleClickAction::Zoom);
        assert_eq!(titlebar_double_click_action(Some("Minimize")),TitlebarDoubleClickAction::Minimize);
        assert_eq!(titlebar_double_click_action(Some("None")),TitlebarDoubleClickAction::None);
        assert_eq!(titlebar_double_click_action(None),TitlebarDoubleClickAction::Zoom);
        assert_eq!(titlebar_double_click_action(Some("unexpected")),TitlebarDoubleClickAction::None);
    }
    #[test]
    fn titlebar_preference_receipt_distinguishes_default_from_unknown_values(){
        assert_eq!(titlebar_double_click_preference(None),(TitlebarDoubleClickAction::Zoom,true));
        for (value,action) in [("Zoom",TitlebarDoubleClickAction::Zoom),("Minimize",TitlebarDoubleClickAction::Minimize),("None",TitlebarDoubleClickAction::None)]{
            assert_eq!(titlebar_double_click_preference(Some(value)),(action,true));
        }
        assert_eq!(titlebar_double_click_preference(Some("unexpected")),(TitlebarDoubleClickAction::None,false));
    }
    fn owned_state() -> State {
        let mut s = State::default();
        s.owners.push(Owner {
            label: "owned".into(),
            role: Role::Center,
            instance: 7,
            document: 2,
            alive: true,
            samples_left: 8,
            page_left: 32,
            last_page_index: 0,
            reservations: BTreeMap::new(),
            pending: Some(Pending {
                index: 1,
                started: Instant::now(),
            }),
        });
        s
    }
    #[test]
    fn alignment_counts_are_bounded_monotonic_and_exact_owner_document() {
        let mut s = owned_state();
        accept_counts(&mut s, 7, 2, 4, 1, 2, 0);
        assert_eq!(s.alignment_counts[&7].schedule_requests, 4);
        accept_counts(&mut s, 7, 1, 9, 2, 3, 0);
        accept_counts(&mut s, 8, 2, 9, 2, 3, 0);
        accept_counts(&mut s, 7, 2, 3, 1, 2, 0);
        assert_eq!(s.alignment_counts[&7].schedule_requests, 4);
        accept_counts(&mut s, 7, 2, 65535, 3, 4, 1);
        assert!(s.alignment_counts[&7].saturated);
        accept_counts(&mut s, 7, 2, 65536, 3, 4, 1);
        assert_eq!(s.alignment_counts[&7].schedule_requests, 65535);
        assert!(s.ring.is_empty()); // Counters consume neither ring nor geometry budget.
        assert_eq!(s.owners[0].samples_left, 8);
    }
    #[test]
    fn button_observations_are_fixed_bounded_and_absent_values_remain_null() {
        let mut p = Snapshot::default();
        assert!(p
            .checked()
            .unwrap()
            .standard_buttons
            .iter()
            .all(|b| b.center_top_wk_pt.is_none()));
        p.buttons[0].present = (1 << 0) | (1 << 1) | (1 << 6) | (1 << 9);
        p.buttons[0].rects[0] = [16., 16., 14., 14.];
        p.buttons[0].rects[1] = [0., 0., 1280., 30.];
        p.buttons[0].center_top_wk = 23.;
        p.buttons[0].background_alpha[0] = 0.5;
        let g = p.checked().unwrap();
        assert_eq!(g.standard_buttons[0].center_top_wk_pt, Some(23.));
        assert_eq!(
            g.standard_buttons[0].parent_bounds_pt,
            Some([0., 0., 1280., 30.])
        );
        assert!(g.standard_buttons[1].button_in_wk_pt.is_none());
        p.buttons[0].background_alpha[0] = 1.1;
        assert!(p.checked().is_none());
        p.buttons[0].background_alpha[0] = 0.5;
        p.buttons[2].flags = 1 << 31;
        assert!(p.checked().is_none());
        p.buttons[2].flags = 0;
        p.buttons[1].present = 1;
        p.buttons[1].rects[0][0] = f64::NAN;
        assert!(p.checked().is_none());
    }
    #[test]
    fn rejected_enqueue_clears_only_exact_request_and_cannot_be_a_move_candidate() {
        let mut s = owned_state();
        complete_drag(&mut s, "owned", (7, 2, 1), false);
        record_moved(&mut s, "owned", (7, 2), [0., 0., 100., 100.]);
        assert!(matches!(
            s.ring.back().unwrap().data,
            Data::Host {
                phase: HostPhase::OtherMoved,
                request_index: None,
                ..
            }
        ));
        s.owners[0].pending = Some(Pending {
            index: 2,
            started: Instant::now(),
        });
        complete_drag(&mut s, "owned", (7, 2, 1), false);
        complete_drag(&mut s, "owned", (7, 1, 2), false);
        complete_drag(&mut s, "owned", (6, 2, 2), false);
        assert_eq!(s.owners[0].pending.as_ref().unwrap().index, 2);
        record_moved(&mut s, "owned", (7, 2), [0., 0., 100., 100.]);
        assert!(matches!(
            s.ring.back().unwrap().data,
            Data::Host {
                phase: HostPhase::MovedCandidate,
                request_index: Some(2),
                ..
            }
        ));
    }
    #[test]
    fn move_sample_crossing_navigation_or_rebuild_is_discarded() {
        let mut s = owned_state();
        let captured = (7, 2);
        s.owners[0].document = 3;
        record_moved(&mut s, "owned", captured, [0.; 4]);
        s.owners[0].document = 2;
        s.owners[0].instance = 8;
        record_moved(&mut s, "owned", captured, [0.; 4]);
        assert!(s.ring.is_empty());
        assert_eq!(s.owners[0].pending.as_ref().unwrap().index, 1);
    }
    #[test]
    fn persistence_rejects_late_snapshots_and_preserves_previous_report_on_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        let mut writer = Persist::default();
        // Serialization of revision 1 completed after revision 2.
        writer
            .write(&path, 2, false, br#"{"stateRevision":2,"finalized":false}"#)
            .unwrap();
        writer.write(&path, 1, false, b"old").unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap()
                ["stateRevision"],
            2
        );
        // A blocked temporary path makes the final write fail without truncating the old file.
        std::fs::create_dir(path.with_extension("json.pending")).unwrap();
        assert!(writer.write(&path, 3, true, b"final").is_err());
        assert_eq!(writer.revision, 2);
        assert!(!writer.finalized);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap()
                ["finalized"],
            false
        );
        std::fs::remove_dir(path.with_extension("json.pending")).unwrap();
        writer.write(&path, 4, true, b"final").unwrap();
        writer.write(&path, 5, false, b"late callback").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"final");
    }
    #[test]
    fn pod_layout_and_present_fields_are_exact() {
        assert_eq!(std::mem::size_of::<Snapshot>(), 1048);
        assert_eq!(std::mem::size_of::<ButtonSnapshot>(), 240);
        assert_eq!(std::mem::offset_of!(Snapshot, buttons), 328);
        assert_eq!(std::mem::align_of::<Snapshot>(), 8);
        assert_eq!(std::mem::offset_of!(Snapshot, owner_generation), 16);
        assert_eq!(std::mem::offset_of!(Snapshot, backing_scale), 32);
        assert_eq!(std::mem::offset_of!(Snapshot, rects), 40);
        let mut p = Snapshot::default();
        assert!(p
            .checked()
            .unwrap()
            .appkit_window_screen_bottom_left_pt
            .is_none());
        p.present = 1;
        p.rects[0] = [0., 0., 760., 520.];
        assert_eq!(
            p.checked().unwrap().appkit_window_screen_bottom_left_pt,
            Some(p.rects[0])
        );
        p.rects[0][0] = f64::NAN;
        assert!(p.checked().is_none());
        p.present = 1 << 31;
        assert!(p.checked().is_none());
    }
    #[test]
    fn typed_page_schema_rejects_unknown_and_irrelevant_data() {
        let mut v = serde_json::json!({"ownerGeneration":1,"documentGeneration":2,"index":1,"phase":"request-start","requestIndex":1});
        assert!(serde_json::from_value::<Observation>(v.clone())
            .unwrap()
            .valid());
        v["text"] = serde_json::json!("must not be accepted");
        assert!(serde_json::from_value::<Observation>(v.clone()).is_err());
        v.as_object_mut().unwrap().remove("text");
        v["xCssPx"] = serde_json::json!(4);
        assert!(!serde_json::from_value::<Observation>(v.clone())
            .unwrap()
            .valid());
        let mut hit:Observation=serde_json::from_value(serde_json::json!({"ownerGeneration":1,"documentGeneration":1,"index":1,"phase":"hit","hit":"rail-top","button":0,"trusted":false,"prevented":false,"eligible":true,"xCssPx":1,"yCssPx":1})).unwrap();
        assert!(hit.valid());
        hit.x_css_px = Some(f64::INFINITY);
        assert!(!hit.valid());
        hit.x_css_px = Some(1.);
        hit.index = 33;
        assert!(!hit.valid());
    }
    #[test]
    fn process_instance_numbers_are_unique_and_not_document_numbers() {
        let a = allocate_instance().unwrap();
        let b = allocate_instance().unwrap();
        assert!(b > a);
    }
    #[test]
    fn ring_keeps_latest_and_signals_drop() {
        let mut s = State::default();
        s.owners.push(Owner {
            label: "owned".into(),
            role: Role::Center,
            instance: allocate_instance().unwrap(),
            document: 1,
            alive: true,
            samples_left: 8,
            page_left: 32,
            last_page_index: 0,
            reservations: BTreeMap::new(),
            pending: None,
        });
        for _ in 0..40 {
            record(&mut s, 0, host(HostPhase::Invalidated, None));
        }
        assert_eq!(s.ring.len(), 32);
        assert_eq!(s.dropped, 8);
        assert!(s.truncated);
        assert_eq!(s.ring.front().unwrap().index, 9);
        assert_eq!(s.ring.back().unwrap().index, 40);
    }
    #[test]
    fn navigation_cancels_pending_and_pairs_without_refunding_budget() {
        let mut s = State::default();
        let mut reservations = BTreeMap::new();
        reservations.insert(
            1,
            Reservation {
                expected: 2,
                left: 1,
            },
        );
        s.owners.push(Owner {
            label: "owned".into(),
            role: Role::Center,
            instance: allocate_instance().unwrap(),
            document: 1,
            alive: true,
            samples_left: 1,
            page_left: 30,
            last_page_index: 2,
            reservations,
            pending: Some(Pending {
                index: 1,
                started: Instant::now(),
            }),
        });
        clear_pending(&mut s, 0);
        assert!(s.owners[0].pending.is_none());
        assert!(s.owners[0].reservations.is_empty());
        assert_eq!(s.cancelled_samples, 1);
        assert_eq!(s.owners[0].samples_left, 1);
    }
    #[test]
    fn exact_process_instances_separate_callback_budgets_and_navigation() {
        let center = allocate_instance().unwrap();
        let service = allocate_instance().unwrap();
        assert_ne!(center, service);
        {
            let mut s = state().lock().unwrap();
            *s = State::default();
            for (label, role, instance) in [
                ("center", Role::Center, center),
                ("service", Role::Service, service),
            ] {
                s.owners.push(Owner {
                    label: label.into(),
                    role,
                    instance,
                    document: 1,
                    alive: true,
                    samples_left: 8,
                    page_left: 32,
                    last_page_index: 0,
                    reservations: BTreeMap::new(),
                    pending: None,
                });
            }
        }
        let pair = reserve(center, 1, 2);
        assert_ne!(pair, 0);
        assert_eq!(reserve(center + service + 1, 1, 2), 0);
        let mut p = Snapshot {
            owner_generation: service,
            document_generation: 1,
            ..Default::default()
        };
        receive(pair, 2, &p);
        assert!(state().lock().unwrap().ring.is_empty());
        p.owner_generation = center;
        receive(pair, 2, &p);
        {
            let s = state().lock().unwrap();
            assert_eq!(s.ring.len(), 1);
            assert_eq!(s.owners[0].samples_left, 6);
            assert_eq!(s.owners[1].samples_left, 8);
        }
        {
            let mut s = state().lock().unwrap();
            clear_pending(&mut s, 0);
            s.owners[0].document = 2;
        }
        receive(pair, 3, &p);
        assert_eq!(state().lock().unwrap().ring.len(), 1);
        assert_eq!(reserve(center, 1, 1), 0);
        assert_eq!(state().lock().unwrap().cancelled_samples, 1);
        {
            let mut s = state().lock().unwrap();
            s.owners[0].samples_left = 1;
        }
        assert_eq!(reserve(center, 2, 2), 0);
        assert!(state().lock().unwrap().truncated);
        assert_eq!(state().lock().unwrap().owners[0].samples_left, 1);
        {
            let mut s = state().lock().unwrap();
            s.owners[0].alive = false;
        }
        assert_eq!(reserve(center, 2, 1), 0);
        assert_ne!(allocate_instance().unwrap(), center);
    }
}
