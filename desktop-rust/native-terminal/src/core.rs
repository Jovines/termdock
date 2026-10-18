//! Engine-independent bounded transport envelope. No VT parser or grid lives here.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

pub const MAX_BATCH_BYTES: usize = 256 * 1024;
pub const MAX_CELLS: usize = 256 * 1024;
pub const MAX_HISTORY_CELLS: usize = 1_000_000;
pub const MAX_HISTORY_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_REPLAY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_REPLAY_RECORDS: usize = 32768;
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;
pub const MAX_EVENTS: usize = 4096;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("expected sequence {expected}, got {got}; not consumed")]
    SequenceGap { expected: u64, got: u64 },
    #[error("batch exceeds 256 KiB")]
    BatchTooLarge,
    #[error("dimensions exceed u16 or 262144 visible cells")]
    Dimensions,
    #[error("resize intermediate shape exceeds the visible cell budget")]
    ResizeBudget,
    #[error("pending batch or callbacks must be drained; not consumed")]
    Backpressure,
    #[error("surface is closed")]
    Closed,
    #[error("engine partially consumed a failed batch; do not retry")]
    EngineFailed,
    #[error("sequence exhausted")]
    SequenceExhausted,
    #[error("exact replay is unavailable; obtain a same-session checkpoint")]
    ReplayUnavailable,
    #[error("replay version, engine, epoch, ownership, or record order is invalid")]
    InvalidReplay,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Palette {
    pub ansi: [[u8; 3]; 16],
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
    pub selection: [u8; 3],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Font {
    pub family: String,
    pub features: Vec<String>,
    #[serde(default)]
    pub letter_spacing: i8,
    #[serde(default)]
    pub extra_height_percent: u8,
    #[serde(default = "normal_weight")]
    pub weight: u16,
    #[serde(default = "bold_weight")]
    pub weight_bold: u16,
    #[serde(default = "default_contrast")]
    pub contrast: u16,
    #[serde(default = "default_true")]
    pub bold_is_bright: bool,
}
fn normal_weight() -> u16 {
    400
}
fn bold_weight() -> u16 {
    700
}
fn default_contrast() -> u16 {
    450
}
fn default_true() -> bool {
    true
}
impl Default for Font {
    fn default() -> Self {
        Self {
            family: "JetBrains Mono".into(),
            features: Vec::new(),
            letter_spacing: 0,
            extra_height_percent: 0,
            weight: 400,
            weight_bold: 700,
            contrast: 450,
            bold_is_bright: true,
        }
    }
}
impl Font {
    pub fn validate(&self) -> Result<(), Error> {
        if self.family.is_empty()
            || !(-5..=10).contains(&self.letter_spacing)
            || self.extra_height_percent > 100
            || !(100..=900).contains(&self.weight)
            || !(100..=900).contains(&self.weight_bold)
            || !(100..=2100).contains(&self.contrast)
            || self.family.len() > 128
            || self
                .family
                .chars()
                .any(|c| c.is_control() || c == '\"' || c == '\\')
            || self.features.len() > 32
            || self.features.iter().any(|s| {
                s.is_empty()
                    || s.len() > 16
                    || !s
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"+-=".contains(&c))
            })
        {
            return Err(Error::Dimensions);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Options {
    #[serde(default)]
    pub font: Font,
    pub columns: usize,
    pub rows: usize,
    /// Requested history rows, also constrained by logical-cell and byte budgets.
    pub history: usize,
    pub palette: Palette,
    #[serde(default = "default_cursor_visible")]
    pub cursor_visible: bool,
    #[serde(default = "default_cursor_blink")]
    pub cursor_blink: bool,
}
fn default_cursor_visible() -> bool { true }
// Older snapshots were created while native config hard-coded blink off.
fn default_cursor_blink() -> bool { false }
/// Exact host-owned remote identity. `view` is the frontend panel, `session`
/// the actual backend PTY, `epoch` the host page epoch. A connection's stream
/// epoch is separate and travels only with a consumed StreamCursor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ownership {
    pub service: String,
    pub target: String,
    pub session: String,
    pub device: String,
    pub window: String,
    pub view: String,
    pub epoch: String,
}
impl Ownership {
    pub fn validate(&self) -> Result<(), Error> {
        if [
            &self.service,
            &self.target,
            &self.session,
            &self.device,
            &self.window,
            &self.view,
            &self.epoch,
        ]
        .iter()
        .any(|s| s.is_empty() || s.len() > 1024 || s.contains('\0'))
        {
            return Err(Error::InvalidReplay);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    Input(Vec<u8>),
    Resize {
        columns: usize,
        rows: usize,
    },
    Selection(String),
    Title(String),
    Bell,
    InputRejected,
    /// Fixed copy failure status, separate from terminal input rejection.
    CopyFailed(u8),
    SearchRequested(String),
    CloseRequested,
    /// Existing page shortcut dispatcher owns application commands.
    Shortcut {
        key_code: u16,
        modifiers: u32,
        key: String,
    },
    /// Image/file paste is read locally by the host; upload stays on the page.
    PasteRequested,
    ClipboardText(String),
    OpenLink(String),
    PathHit(String),
    /// A file drop accepted by this native view. Paths remain local and are
    /// resolved through the window and view-bound shell capability.
    FileDrop(Vec<String>),
    /// Host must remeasure parent rect/scale after AppKit backing changes.
    LayoutRequested,
    Wheel(String),
    PointerPressed,
    /// Actual AppKit first-responder transitions, ordered within this surface.
    FocusChanged { focused: bool, revision: u64 },
    /// Returned only after real Ghostty consumption and its IO barrier.
    Ack(BatchAck),
    Ready,
    Fatal(String),
}
impl HostEvent {
    fn bytes(&self) -> usize {
        match self {
            Self::Input(v) => v.len(),
            Self::Shortcut { key, .. } => key.len(),
            Self::Wheel(data)
            | Self::ClipboardText(data)
            | Self::OpenLink(data)
            | Self::PathHit(data) => data.len(),
            Self::FileDrop(paths) => paths
                .iter()
                .fold(0usize, |total, path| total.saturating_add(path.len())),
            Self::Selection(v) | Self::Title(v) | Self::SearchRequested(v) | Self::Fatal(v) => {
                v.len()
            }
            _ => 0,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchAck {
    pub sequence: u64,
    pub duplicate: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Submission {
    /// Accepted into one bounded in-flight slot. NOT a consumption ACK.
    Pending {
        sequence: u64,
    },
    Duplicate(BatchAck),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ReplayRecord {
    Output {
        sequence: u64,
        bytes: Vec<u8>,
    },
    /// Exact physical geometry given to the pinned engine (zero padding).
    Size {
        width_px: u32,
        height_px: u32,
        scale: f64,
        columns: usize,
        rows: usize,
    },
    /// Normalize Ghostty synchronized-output timer state at checkpoint.
    FlushSync,
    Palette(Palette),
    FontSize {
        size: f64,
        columns: usize,
        rows: usize,
    },
    History(usize),
    SnapshotMetadata(String),
    Font {
        font: Font,
        columns: usize,
        rows: usize,
    },
}
pub const ENGINE: &str = "ghostty-21c717340b62349d67124446c2447bf38796540b-td4";
pub const REPLAY_VERSION: u32 = 4;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Replay {
    pub version: u32,
    pub engine: String,
    pub ownership: Ownership,
    pub initial: Options,
    pub font_size: f64,
    pub records: Vec<ReplayRecord>,
    pub last_sequence: u64,
    /// Pinned Ghostty history viewport, restored after replay completion.
    pub viewport_offset: usize,
}
pub(crate) fn valid_size(columns: usize, rows: usize) -> bool {
    (2..=u16::MAX as usize).contains(&columns)
        && (1..=u16::MAX as usize).contains(&rows)
        && columns.checked_mul(rows).is_some_and(|v| v <= MAX_CELLS)
}
pub fn validate_resize_shape(old: (usize, usize), new: (usize, usize)) -> Result<(), Error> {
    if !valid_size(old.0, old.1) || !valid_size(new.0, new.1) {
        return Err(Error::Dimensions);
    }
    // Conservative guard retained from the previous review. Ghostty allocates
    // paged storage, not Alacritty's 1000-row cache; see locked source notes.
    if new.0.checked_mul(old.1).is_none_or(|v| v > MAX_CELLS) {
        return Err(Error::ResizeBudget);
    }
    if old
        .0
        .checked_mul(old.1.max(new.1))
        .is_none_or(|v| v > MAX_CELLS)
    {
        return Err(Error::ResizeBudget);
    }
    Ok(())
}
pub fn history_cells(request: usize, columns: usize) -> usize {
    request.min(100_000).min(MAX_HISTORY_CELLS / columns) * columns
}
/// A byte ceiling independent of initial width: cell/row retention is enforced
/// by Ghostty's actual page trimming. Packed Cell is 8B, with separate row,
/// style, grapheme, hyperlink and page slack. 16MiB allows ordinary 1M-cell
/// history plus metadata; unusually rich metadata can hit this separate cap.
/// It is a ceiling, not preallocation. Zero history disables scrollback.
pub fn history_bytes(options: &Options) -> usize {
    if options.history == 0 {
        0
    } else {
        MAX_HISTORY_BYTES
    }
}

pub struct Envelope {
    initial: Options,
    ownership: Ownership,
    font_size: f64,
    size: (usize, usize),
    last_sequence: u64,
    pending: Option<(u64, Vec<u8>)>,
    journal: Option<Vec<ReplayRecord>>,
    journal_bytes: usize,
    closed: bool,
    failed: bool,
}
impl Envelope {
    pub fn new(options: Options, ownership: Ownership, font_size: f64) -> Result<Self, Error> {
        ownership.validate()?;
        options.font.validate()?;
        if !valid_size(options.columns, options.rows)
            || !font_size.is_finite()
            || !(1.0..=500.0).contains(&font_size)
        {
            return Err(Error::Dimensions);
        }
        Ok(Self {
            size: (options.columns, options.rows),
            initial: options,
            ownership,
            font_size,
            last_sequence: 0,
            pending: None,
            journal: Some(Vec::new()),
            journal_bytes: 0,
            closed: false,
            failed: false,
        })
    }
    pub fn rebind_epoch(&mut self, owner: Ownership) -> Result<(), Error> {
        owner.validate()?;
        let mut expected = self.ownership.clone();
        expected.epoch = owner.epoch.clone();
        if expected != owner || self.pending.is_some() || self.failed || self.closed {
            return Err(Error::InvalidReplay);
        }
        self.ownership = owner;
        Ok(())
    }
    pub fn dimensions(&self) -> (usize, usize) {
        self.size
    }
    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }
    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn ownership(&self) -> &Ownership {
        &self.ownership
    }
    pub fn validate_write(&self, sequence: u64, bytes: &[u8]) -> Result<Submission, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if self.failed {
            return Err(Error::EngineFailed);
        }
        if bytes.len() > MAX_BATCH_BYTES {
            return Err(Error::BatchTooLarge);
        }
        if sequence != 0 && sequence <= self.last_sequence {
            return Ok(Submission::Duplicate(BatchAck {
                sequence: self.last_sequence,
                duplicate: true,
            }));
        }
        if self.pending.is_some() {
            return Err(Error::Backpressure);
        }
        let expected = self
            .last_sequence
            .checked_add(1)
            .ok_or(Error::SequenceExhausted)?;
        if sequence != expected {
            return Err(Error::SequenceGap {
                expected,
                got: sequence,
            });
        }
        Ok(Submission::Pending { sequence })
    }
    pub fn reserve(&mut self, sequence: u64, bytes: &[u8]) -> Result<Submission, Error> {
        let submission = self.validate_write(sequence, bytes)?;
        if matches!(submission, Submission::Pending { .. }) {
            self.pending = Some((sequence, bytes.to_vec()));
        }
        Ok(submission)
    }
    #[cfg(any(target_os = "macos", feature = "check-native-api"))]
    pub(crate) fn cancel_reservation(&mut self) {
        self.pending = None;
    }
    pub fn complete(&mut self, sequence: u64, success: bool) -> Result<BatchAck, Error> {
        let Some((pending, bytes)) = self.pending.take() else {
            return Err(Error::EngineFailed);
        };
        if sequence != pending || !success {
            self.failed = true;
            self.journal = None;
            return Err(Error::EngineFailed);
        }
        self.last_sequence = sequence;
        self.record(ReplayRecord::Output { sequence, bytes });
        Ok(BatchAck {
            sequence,
            duplicate: false,
        })
    }
    pub fn resize(
        &mut self,
        width_px: u32,
        height_px: u32,
        scale: f64,
        columns: usize,
        rows: usize,
    ) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if self.pending.is_some() {
            return Err(Error::Backpressure);
        }
        if !scale.is_finite()
            || !(1.0..=4.0).contains(&scale)
            || width_px == 0
            || height_px == 0
            || width_px > 131072
            || height_px > 131072
        {
            return Err(Error::Dimensions);
        }
        validate_resize_shape(self.size, (columns, rows))?;
        self.size = (columns, rows);
        self.record(ReplayRecord::Size {
            width_px,
            height_px,
            scale,
            columns,
            rows,
        });
        Ok(())
    }
    pub fn palette(&mut self, palette: Palette) {
        self.record(ReplayRecord::Palette(palette));
    }
    pub fn font(&mut self, font: Font, columns: usize, rows: usize) -> Result<(), Error> {
        font.validate()?;
        validate_resize_shape(self.size, (columns, rows))?;
        self.size = (columns, rows);
        self.record(ReplayRecord::Font {
            font,
            columns,
            rows,
        });
        Ok(())
    }
    fn record(&mut self, record: ReplayRecord) {
        let Some(journal) = &mut self.journal else {
            return;
        };
        let bytes = match &record {
            ReplayRecord::Output { bytes, .. } => bytes.len(),
            ReplayRecord::SnapshotMetadata(data) => data.len(),
            ReplayRecord::Font { font, .. } => {
                font.family.len() + font.features.iter().map(String::len).sum::<usize>() + 128
            }
            _ => 128,
        };
        if self.journal_bytes.saturating_add(bytes) > MAX_REPLAY_BYTES
            || journal.len() >= MAX_REPLAY_RECORDS
        {
            self.journal = None;
            self.journal_bytes = 0;
            return;
        }
        self.journal_bytes += bytes;
        journal.push(record);
    }
    pub fn snapshot_metadata(&mut self, data: String) -> Result<(), Error> {
        if data.len() > 128 * 1024 {
            return Err(Error::InvalidReplay);
        }
        let value: serde_json::Value =
            serde_json::from_str(&data).map_err(|_| Error::InvalidReplay)?;
        if value["version"] != 1 || !value["state"].is_object() {
            return Err(Error::InvalidReplay);
        }
        self.record(ReplayRecord::SnapshotMetadata(data));
        Ok(())
    }
    pub fn history(&mut self, history: usize) -> Result<(), Error> {
        if history > 100_000 {
            return Err(Error::Dimensions);
        }
        self.record(ReplayRecord::History(history));
        Ok(())
    }
    pub fn font_size(&mut self, size: f64, columns: usize, rows: usize) -> Result<(), Error> {
        if !size.is_finite() || !(1.0..=500.0).contains(&size) {
            return Err(Error::Dimensions);
        }
        validate_resize_shape(self.size, (columns, rows))?;
        self.size = (columns, rows);
        self.record(ReplayRecord::FontSize {
            size,
            columns,
            rows,
        });
        Ok(())
    }
    pub fn flush_sync(&mut self) {
        self.record(ReplayRecord::FlushSync);
    }
    pub fn export_replay(&self, viewport_offset: usize) -> Result<Replay, Error> {
        if self.closed || self.failed || self.pending.is_some() {
            return Err(Error::Backpressure);
        }
        Ok(Replay {
            version: REPLAY_VERSION,
            engine: ENGINE.into(),
            ownership: self.ownership.clone(),
            initial: self.initial.clone(),
            font_size: self.font_size,
            records: self.journal.clone().ok_or(Error::ReplayUnavailable)?,
            last_sequence: self.last_sequence,
            viewport_offset,
        })
    }
    pub fn validate_replay(replay: &Replay, owner: &Ownership) -> Result<(), Error> {
        if replay.version != REPLAY_VERSION
            || replay.engine != ENGINE
            || &replay.ownership != owner
            || replay.records.len() > MAX_REPLAY_RECORDS
            || replay.viewport_offset > MAX_HISTORY_CELLS
        {
            return Err(Error::InvalidReplay);
        }
        let mut envelope = Self::new(replay.initial.clone(), owner.clone(), replay.font_size)?;
        let mut bytes = 0usize;
        for record in &replay.records {
            match record {
                ReplayRecord::Output {
                    sequence,
                    bytes: data,
                } => {
                    bytes = bytes.checked_add(data.len()).ok_or(Error::InvalidReplay)?;
                    envelope.reserve(*sequence, data)?;
                    envelope.complete(*sequence, true)?;
                }
                ReplayRecord::Size {
                    width_px,
                    height_px,
                    scale,
                    columns,
                    rows,
                } => {
                    bytes = bytes.checked_add(128).ok_or(Error::InvalidReplay)?;
                    envelope.resize(*width_px, *height_px, *scale, *columns, *rows)?;
                }
                ReplayRecord::Font {
                    font,
                    columns,
                    rows,
                } => {
                    envelope.font(font.clone(), *columns, *rows)?;
                    bytes = bytes
                        .checked_add(
                            font.family.len()
                                + font.features.iter().map(String::len).sum::<usize>()
                                + 128,
                        )
                        .ok_or(Error::InvalidReplay)?;
                }
                ReplayRecord::SnapshotMetadata(data) => {
                    envelope.snapshot_metadata(data.clone())?;
                    bytes = bytes.checked_add(data.len()).ok_or(Error::InvalidReplay)?;
                }
                ReplayRecord::History(history) => {
                    envelope.history(*history)?;
                    bytes = bytes.checked_add(128).ok_or(Error::InvalidReplay)?;
                }
                ReplayRecord::FontSize {
                    size,
                    columns,
                    rows,
                } => {
                    envelope.font_size(*size, *columns, *rows)?;
                    bytes = bytes.checked_add(128).ok_or(Error::InvalidReplay)?;
                }
                ReplayRecord::FlushSync | ReplayRecord::Palette(_) => {
                    bytes = bytes.checked_add(128).ok_or(Error::InvalidReplay)?;
                }
            }
            if bytes > MAX_REPLAY_BYTES {
                return Err(Error::InvalidReplay);
            }
        }
        if envelope.last_sequence != replay.last_sequence {
            return Err(Error::InvalidReplay);
        }
        Ok(())
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.pending = None;
        self.journal = None;
    }
}

#[derive(Default)]
struct Events {
    queue: VecDeque<HostEvent>,
    bytes: usize,
    closing: bool,
}
/// IO callbacks wait for capacity; the AppKit thread never waits here.
/// Closing wakes blocked callbacks before worker join/surface destruction.
#[derive(Default)]
pub struct WakeSignal {
    listener: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
impl WakeSignal {
    pub fn set(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        *self.listener.lock().unwrap() = Some(listener);
    }
    pub fn wake(&self) {
        let listener = self.listener.lock().unwrap().clone();
        if let Some(listener) = listener {
            listener();
        }
    }
}
#[derive(Default)]
pub struct EventQueue {
    pub wake: Arc<WakeSignal>,
    events: Mutex<Events>,
    capacity: Condvar,
}
impl EventQueue {
    pub fn can_accept_input(&self) -> bool {
        let e = self.events.lock().unwrap();
        !e.closing
            && e.bytes <= MAX_EVENT_BYTES - 2 * MAX_BATCH_BYTES - 32768
            && e.queue.len() < MAX_EVENTS / 2
    }
    pub fn push(&self, event: HostEvent, io_thread: bool) -> Result<(), Error> {
        let cost = event.bytes();
        if cost > MAX_BATCH_BYTES {
            return Err(Error::BatchTooLarge);
        }
        let mut e = self.events.lock().unwrap();
        while e.bytes + cost > MAX_EVENT_BYTES || e.queue.len() >= MAX_EVENTS {
            if e.closing {
                return Err(Error::Closed);
            }
            if !io_thread {
                return Err(Error::Backpressure);
            }
            e = self.capacity.wait(e).unwrap();
        }
        if e.closing {
            return Err(Error::Closed);
        }
        e.bytes += cost;
        e.queue.push_back(event);
        drop(e);
        self.wake.wake();
        Ok(())
    }
    pub fn drain(&self) -> Vec<HostEvent> {
        let mut e = self.events.lock().unwrap();
        let events = e.queue.drain(..).collect();
        e.bytes = 0;
        self.capacity.notify_all();
        events
    }
    pub fn close(&self) {
        let mut e = self.events.lock().unwrap();
        e.closing = true;
        self.capacity.notify_all();
    }
}

/// Separate from raw replay v4 and legacy xterm text. Data is a bounded JSON
/// string produced by the locked engine formatter plus typed scalar metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DurableSnapshot {
    pub version: u32,
    pub engine: String,
    pub owner: Ownership,
    pub options: Options,
    pub font_size: f64,
    pub data: String,
    pub data_sha256: String,
    pub cursor: StreamCursor,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamCursor {
    pub seq: u64,
    pub epoch: String,
}
impl DurableSnapshot {
    pub fn validate(
        &self,
        owner: &Ownership,
        options: &Options,
        font_size: f64,
    ) -> Result<(), Error> {
        let mut expected = self.owner.clone();
        expected.epoch = owner.epoch.clone();
        if self.version != 1
            || self.engine != ENGINE
            || expected != *owner
            || self.options != *options
            || self.font_size != font_size
            || self.data.len() > 128 * 1024
            || self.data_sha256.len() != 64
            || !self
                .data_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.cursor.seq == 0
            || self.cursor.epoch.is_empty()
            || self.cursor.epoch.len() > 1024
        {
            return Err(Error::InvalidReplay);
        }
        owner.validate()?;
        Ok(())
    }
}
