use crate::core::*;
use std::sync::{mpsc, Arc};
use std::time::Duration;
fn options() -> Options {
    Options {
        font: Font::default(),
        columns: 80,
        rows: 24,
        history: 1000,
        palette: Palette {
            ansi: [[0; 3]; 16],
            foreground: [1; 3],
            background: [0; 3],
            cursor: [1; 3],
            selection: [1; 3],
        },
        cursor_visible: true,
        cursor_blink: true,
    }
}
#[test]
fn cursor_preferences_default_for_snapshots_written_before_the_fields_existed() {
    let mut value = serde_json::to_value(options()).unwrap();
    value.as_object_mut().unwrap().remove("cursor_visible");
    value.as_object_mut().unwrap().remove("cursor_blink");
    let restored: Options = serde_json::from_value(value).unwrap();
    assert!(restored.cursor_visible);
    assert!(!restored.cursor_blink);
}
fn owner() -> Ownership {
    Ownership {
        service: "s".into(),
        target: "t".into(),
        session: "pty".into(),
        device: "d".into(),
        window: "w".into(),
        view: "v".into(),
        epoch: "e".into(),
    }
}
fn envelope() -> Envelope {
    Envelope::new(options(), owner(), 14.).unwrap()
}
#[test]
fn queue_is_not_ack_and_gaps_duplicates_do_not_consume() {
    let mut e = envelope();
    assert_eq!(
        e.reserve(2, b"bad"),
        Err(Error::SequenceGap {
            expected: 1,
            got: 2
        })
    );
    assert_eq!(
        e.reserve(1, b"\x1b[31m\xe4"),
        Ok(Submission::Pending { sequence: 1 })
    );
    assert_eq!(e.last_sequence(), 0);
    assert_eq!(e.reserve(1, b"\x1b[31m\xe4"), Err(Error::Backpressure));
    assert_eq!(e.export_replay(0).unwrap_err(), Error::Backpressure);
    assert_eq!(
        e.complete(1, true).unwrap(),
        BatchAck {
            sequence: 1,
            duplicate: false
        }
    );
    assert_eq!(
        e.reserve(1, b"old"),
        Ok(Submission::Duplicate(BatchAck {
            sequence: 1,
            duplicate: true
        }))
    );
    e.reserve(2, b"\xb8\xad").unwrap();
    e.complete(2, true).unwrap();
    let r = e.export_replay(0).unwrap();
    Envelope::validate_replay(&r, &owner()).unwrap();
    assert_eq!(
        r.records[0],
        ReplayRecord::Output {
            sequence: 1,
            bytes: b"\x1b[31m\xe4".to_vec()
        }
    );
    assert_eq!(
        r.records[1],
        ReplayRecord::Output {
            sequence: 2,
            bytes: b"\xb8\xad".to_vec()
        }
    );
}
#[test]
fn reject_oversize_failed_partial_consume_and_closed_without_retry() {
    let mut e = envelope();
    assert_eq!(
        e.reserve(1, &vec![0; MAX_BATCH_BYTES + 1]),
        Err(Error::BatchTooLarge)
    );
    e.reserve(1, b"abc").unwrap();
    assert_eq!(e.complete(1, false), Err(Error::EngineFailed));
    assert_eq!(e.reserve(1, b"abc"), Err(Error::EngineFailed));
    assert_eq!(e.last_sequence(), 0);
    e.close();
    assert_eq!(e.reserve(1, b"abc"), Err(Error::Closed));
}
#[test]
fn replay_rejects_old_engine_identity_epoch_corruption_and_budget() {
    let mut e = envelope();
    e.reserve(1, b"a").unwrap();
    e.complete(1, true).unwrap();
    let r = e.export_replay(0).unwrap();
    let mut x = r.clone();
    x.version = 2;
    assert_eq!(
        Envelope::validate_replay(&x, &owner()),
        Err(Error::InvalidReplay)
    );
    let mut x = r.clone();
    x.engine = "alacritty".into();
    assert_eq!(
        Envelope::validate_replay(&x, &owner()),
        Err(Error::InvalidReplay)
    );
    let mut x = r.clone();
    x.engine = ENGINE.replace("-td4", "-td3");
    assert_eq!(
        Envelope::validate_replay(&x, &owner()),
        Err(Error::InvalidReplay)
    );
    for field in 0..7 {
        let mut x = owner();
        match field {
            0 => x.service = "other".into(),
            1 => x.target = "other".into(),
            2 => x.session = "other".into(),
            3 => x.device = "other".into(),
            4 => x.window = "other".into(),
            5 => x.view = "other".into(),
            _ => x.epoch = "other".into(),
        };
        assert_eq!(Envelope::validate_replay(&r, &x), Err(Error::InvalidReplay));
    }
    let mut x = r.clone();
    x.last_sequence = 2;
    assert_eq!(
        Envelope::validate_replay(&x, &owner()),
        Err(Error::InvalidReplay)
    );
    let mut x = r;
    x.records.push(ReplayRecord::Output {
        sequence: 3,
        bytes: vec![0],
    });
    assert!(Envelope::validate_replay(&x, &owner()).is_err());
}
#[test]
fn resize_and_history_budget_are_preflighted_and_journaled() {
    assert_eq!(
        validate_resize_shape((65535, 4), (2, 65535)),
        Err(Error::ResizeBudget)
    );
    assert_eq!(
        validate_resize_shape((80, 24), (65536, 1)),
        Err(Error::Dimensions)
    );
    let mut e = envelope();
    e.reserve(1, b"x").unwrap();
    assert_eq!(e.resize(800, 600, 2., 80, 30), Err(Error::Backpressure));
    e.complete(1, true).unwrap();
    e.resize(800, 600, 2., 80, 30).unwrap();
    e.palette(options().palette);
    let r = e.export_replay(12).unwrap();
    Envelope::validate_replay(&r, &owner()).unwrap();
    let mut o = options();
    o.history = usize::MAX;
    for columns in [2, 80, 65535] {
        o.columns = columns;
        assert!(history_bytes(&o) <= MAX_HISTORY_BYTES);
        assert!(history_cells(o.history, columns) <= MAX_HISTORY_CELLS);
    }
}
#[test]
fn replay_budget_exhaustion_releases_journal_not_live_output() {
    let mut e = envelope();
    let data = vec![b'x'; MAX_BATCH_BYTES];
    for seq in 1..=34 {
        e.reserve(seq, &data).unwrap();
        e.complete(seq, true).unwrap();
    }
    assert_eq!(e.last_sequence(), 34);
    assert_eq!(e.export_replay(0).unwrap_err(), Error::ReplayUnavailable);
}
#[test]
fn callbacks_block_only_io_preserve_order_and_wake_on_drain() {
    let q = Arc::new(EventQueue::default());
    for _ in 0..4 {
        q.push(HostEvent::Input(vec![0; MAX_BATCH_BYTES]), false)
            .unwrap();
    }
    assert_eq!(
        q.push(HostEvent::Input(vec![1]), false),
        Err(Error::Backpressure)
    );
    let (tx, rx) = mpsc::channel();
    let other = q.clone();
    let join = std::thread::spawn(move || {
        tx.send(other.push(HostEvent::Input(vec![42]), true))
            .unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
    let events = q.drain();
    assert_eq!(events.len(), 4);
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Ok(()));
    join.join().unwrap();
    assert_eq!(q.drain(), vec![HostEvent::Input(vec![42])]);
}
#[test]
fn closing_unblocks_callbacks_before_worker_join() {
    let q = Arc::new(EventQueue::default());
    for _ in 0..MAX_EVENTS {
        q.push(HostEvent::Bell, false).unwrap();
    }
    let other = q.clone();
    let join = std::thread::spawn(move || other.push(HostEvent::Bell, true));
    q.close();
    assert_eq!(join.join().unwrap(), Err(Error::Closed));
    assert_eq!(q.drain().len(), MAX_EVENTS);
    assert_eq!(q.push(HostEvent::Bell, false), Err(Error::Closed));
}
#[test]
fn default_runtime_contains_no_second_parser_or_local_transport() {
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest.contains("alacritty"));
    let host = include_str!("../native/TDGhostty.m");
    assert!(host.contains("GHOSTTY_BACKEND_EXTERNAL"));
    assert!(!host.contains("fork("));
    assert!(!host.contains("posix_spawn"));
    assert!(!host.contains("NSURLSession"));
}

#[test]
fn font_config_cannot_inject_additional_engine_options() {
    let mut f = Font::default();
    f.validate().unwrap();
    f.family = "Menlo\ncommand = sh".into();
    assert_eq!(f.validate(), Err(Error::Dimensions));
    let mut f = Font {
        features: vec!["+calt".into(), "-liga".into()],
        ..Default::default()
    };
    f.validate().unwrap();
    f.features.push("calt\ncommand=x".into());
    assert_eq!(f.validate(), Err(Error::Dimensions));
}

#[test]
fn replay_checkpoint_preserves_split_parser_input_and_sync_normalization_order() {
    let mut e = envelope();
    e.reserve(1, b"\x1b[?2026h\xe4\xb8").unwrap();
    e.complete(1, true).unwrap();
    e.flush_sync();
    e.reserve(2, b"\xad").unwrap();
    e.complete(2, true).unwrap();
    let r = e.export_replay(0).unwrap();
    assert!(matches!(r.records[1], ReplayRecord::FlushSync));
    Envelope::validate_replay(&r, &owner()).unwrap();
    assert_eq!(r.last_sequence, 2);
}

extern "C" {
    fn td_shortcut_down(state: *mut u64, keycode: u16, captured: bool, repeat: bool) -> bool;
    fn td_shortcut_release(state: *mut u64, keycode: u16) -> bool;
    fn td_preedit_mark(state: *mut u8);
    fn td_preedit_cancel(state: *mut u8);
    fn td_preedit_step(state: *mut u8, busy: bool) -> i32;
    fn td_modifier_action(keycode: u16, flags: u64, masks: *const u64) -> i32;
}
#[test]
fn production_preedit_scheduler_clears_visible_blur_busy_blur_and_overlay_before_refocus() {
    unsafe {
        for busy in [false, true] {
            let mut state = 0;
            td_preedit_mark(&mut state);
            assert_eq!(td_preedit_step(&mut state, false), 2); // already displayed IME
            td_preedit_cancel(&mut state); // blur even though view stays visible
            if busy {
                assert_eq!(td_preedit_step(&mut state, true), 0);
                assert_eq!(td_preedit_step(&mut state, true), 0);
            }
            assert_eq!(td_preedit_step(&mut state, false), 1); // engine clear, no commit
            assert_eq!(td_preedit_step(&mut state, false), 0);
            td_preedit_cancel(&mut state); // overlay hide
            td_preedit_mark(&mut state); // refocus/new IME before busy feed ends
            assert_eq!(td_preedit_step(&mut state, true), 0);
            assert_eq!(td_preedit_step(&mut state, false), 1); // old composing clears first
            assert_eq!(td_preedit_step(&mut state, false), 2); // then new marked text
            assert_eq!(td_preedit_step(&mut state, false), 0);
        }
    }
}
#[test]
fn production_modifier_conversion_tracks_each_side_release_with_opposite_side_held() {
    let masks: [u64; 9] = std::array::from_fn(|i| 1 << i);
    unsafe {
        for (left, right, index) in [
            (0x38, 0x3c, 1),
            (0x3b, 0x3e, 3),
            (0x3a, 0x3d, 5),
            (0x37, 0x36, 7),
        ] {
            let l = masks[index];
            let r = masks[index + 1];
            assert_eq!(td_modifier_action(left, l, masks.as_ptr()), 1);
            assert_eq!(td_modifier_action(right, r, masks.as_ptr()), 1);
            assert_eq!(td_modifier_action(left, l | r, masks.as_ptr()), 1);
            assert_eq!(td_modifier_action(right, l | r, masks.as_ptr()), 1);
            assert_eq!(td_modifier_action(left, r, masks.as_ptr()), 0);
            assert_eq!(td_modifier_action(right, l, masks.as_ptr()), 0);
            assert_eq!(td_modifier_action(left, 0, masks.as_ptr()), 0);
            assert_eq!(td_modifier_action(right, 0, masks.as_ptr()), 0);
        }
        assert_eq!(td_modifier_action(0x39, masks[0], masks.as_ptr()), 1);
        assert_eq!(td_modifier_action(0x39, 0, masks.as_ptr()), 0);
        assert_eq!(td_modifier_action(0xffff, u64::MAX, masks.as_ptr()), -1);
    }
}

#[test]
fn epoch_rebind_requires_exact_identity_and_complete_consumption() {
    let mut e = envelope();
    let mut next = owner();
    next.epoch = "new-page".into();
    e.reserve(1, b"old output").unwrap();
    assert_eq!(e.rebind_epoch(next.clone()), Err(Error::InvalidReplay));
    e.complete(1, true).unwrap();
    e.rebind_epoch(next.clone()).unwrap();
    assert_eq!(e.last_sequence(), 1);
    for field in ["service", "target", "session", "device", "window", "view"] {
        let mut value = serde_json::to_value(&next).unwrap();
        value[field] = serde_json::json!("other");
        assert_eq!(
            e.rebind_epoch(serde_json::from_value(value).unwrap()),
            Err(Error::InvalidReplay)
        );
    }
}
#[test]
fn dynamic_font_size_and_history_are_ordered_and_old_schema_is_rejected() {
    let mut e = envelope();
    e.font_size(18., 70, 20).unwrap();
    e.history(0).unwrap();
    e.reserve(1, b"\x1b[?1049h").unwrap();
    e.complete(1, true).unwrap();
    let mut replay = e.export_replay(0).unwrap();
    assert!(matches!(
        replay.records[0],
        ReplayRecord::FontSize {
            size: 18.,
            columns: 70,
            rows: 20
        }
    ));
    assert!(matches!(replay.records[1], ReplayRecord::History(0)));
    Envelope::validate_replay(&replay, &owner()).unwrap();
    replay.version = 3;
    assert_eq!(
        Envelope::validate_replay(&replay, &owner()),
        Err(Error::InvalidReplay)
    );
    assert_eq!(e.font_size(f64::NAN, 70, 20), Err(Error::Dimensions));
}
#[test]
fn durable_snapshot_is_separate_and_bound_to_geometry_font_palette_and_public_identity() {
    let options = options();
    let owner = owner();
    let snapshot = DurableSnapshot {
        version: 1,
        engine: ENGINE.into(),
        owner: owner.clone(),
        options: options.clone(),
        font_size: 14.,
        data: "{\"version\":1,\"vt\":\"raw\",\"state\":{}}".into(),
        data_sha256: "0".repeat(64),
        cursor: StreamCursor {
            seq: 40,
            epoch: "stream".into(),
        },
    };
    let mut new_owner = owner.clone();
    new_owner.epoch = "new-page".into();
    snapshot.validate(&new_owner, &options, 14.).unwrap();
    new_owner.device = "other".into();
    assert_eq!(
        snapshot.validate(&new_owner, &options, 14.),
        Err(Error::InvalidReplay)
    );
    let mut changed = options.clone();
    changed.columns = 81;
    assert_eq!(
        snapshot.validate(&owner, &changed, 14.),
        Err(Error::InvalidReplay)
    );
    assert_eq!(
        snapshot.validate(&owner, &options, 15.),
        Err(Error::InvalidReplay)
    );
}

#[test]
fn production_shortcuts_suppress_only_matching_releases_after_repeats_and_modifier_release() {
    let mut keys = [0_u64; 4];
    unsafe {
        for key in [0_u16, 40, 117, 124, 255] {
            td_shortcut_down(keys.as_mut_ptr(), key, true, false);
            td_shortcut_down(keys.as_mut_ptr(), key, true, true); // repeat stays one held key
        }
        assert!(!td_shortcut_release(keys.as_mut_ptr(), 36)); // ordinary Enter
        for key in [117_u16, 0, 255, 124, 40] {
            assert!(td_shortcut_release(keys.as_mut_ptr(), key));
            assert!(!td_shortcut_release(keys.as_mut_ptr(), key));
        }
        td_shortcut_down(keys.as_mut_ptr(), u16::MAX, true, false);
        assert!(!td_shortcut_release(keys.as_mut_ptr(), u16::MAX));
        assert_eq!(keys, [0; 4]);
        td_shortcut_down(keys.as_mut_ptr(), 40, true, false);
        // Key-up went to another responder during blur. A fresh plain press
        // belongs to the engine and must receive its normal release.
        assert!(!td_shortcut_down(keys.as_mut_ptr(), 40, false, false));
        assert!(!td_shortcut_release(keys.as_mut_ptr(), 40));
        td_shortcut_down(keys.as_mut_ptr(), 40, true, false);
        assert!(td_shortcut_down(keys.as_mut_ptr(), 40, false, true)); // modifier first released
        assert!(td_shortcut_release(keys.as_mut_ptr(), 40));
        assert_eq!(keys, [0; 4]);
    }
}
