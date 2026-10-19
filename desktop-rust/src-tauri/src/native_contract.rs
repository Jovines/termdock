//! Native terminal requests accept bounded data and panel capabilities, never
//! native pointers, service/target/window identity or credentials from a renderer.
use serde::{Deserialize, Serialize};
use termdock_native_terminal::{Font, Options, Palette};
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Clip {
        token: String,
        holes: Vec<[f64; 4]>,
        generation: String,
        #[serde(rename = "viewportWidth")]
        viewport_width: f64,
        #[serde(rename = "viewportHeight")]
        viewport_height: f64,
    },
    CopyText {
        token: String,
        #[serde(rename = "copyId")]
        copy_id: String,
        text: String,
    },
    ClipboardText {
        token: String,
    },
    Menu {
        token: String,
        id: String,
    },
    Capture {
        token: String,
        sequence: u64,
        cursor: Cursor,
    },
    Restore {
        token: String,
        snapshot: termdock_native_terminal::core::DurableSnapshot,
    },
    Create {
        view: String,
        session: String,
        device: String,
        options: Options,
        #[serde(rename = "fontSize")]
        font_size: f64,
        #[serde(rename = "viewportWidth")]
        viewport_width: f64,
        #[serde(rename = "viewportHeight")]
        viewport_height: f64,
    },
    Write {
        token: String,
        sequence: u64,
        base64: String,
        replay: bool,
        #[serde(rename = "replayEnd")]
        replay_end: bool,
        cursor: Option<Cursor>,
    },
    /// Reports only a completed actual IO barrier; does not enqueue work.
    Layout { token: String },
    /// User-local full parser reset; no PTY command or caller-supplied cursor.
    LocalReset { token: String },
    Inspect { token: String },
    Rect {
        token: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        #[serde(rename = "viewportWidth")]
        viewport_width: f64,
        #[serde(rename = "viewportHeight")]
        viewport_height: f64,
        #[serde(default)]
        holes: Option<Vec<[f64; 4]>>,
        #[serde(default)]
        generation: Option<String>,
    },
    Visible {
        token: String,
        visible: bool,
    },
    Focus {
        token: String,
        focused: bool,
    },
    Palette {
        token: String,
        palette: Palette,
    },
    Cursor {
        token: String,
        visible: bool,
        blink: bool,
    },
    Font {
        token: String,
        font: Font,
    },
    Policy {
        token: String,
        tmux: bool,
    },
    History {
        token: String,
        history: usize,
    },
    FontSize {
        token: String,
        size: f64,
    },
    Search {
        token: String,
        needle: String,
        direction: i32,
    },
    Paste {
        token: String,
        text: String,
    },
    Copy {
        token: String,
        selection: bool,
    },
    Command {
        token: String,
        command: String,
    },
    Checkpoint {
        token: String,
        sequence: u64,
        cursor: Cursor,
    },
    Destroy {
        token: String,
    },
    HideAll {
        generation: String,
    },
    /// Keeps the DOM overlay gated while every live native surface applies
    /// its local exclusion mask for this generation without disappearing.
    PrepareOverlay {
        generation: String,
        #[serde(rename = "viewportWidth")]
        viewport_width: f64,
        #[serde(rename = "viewportHeight")]
        viewport_height: f64,
        holes: Vec<[f64; 4]>,
    },
    ResumeAll {
        generation: String,
    },
    RetireAll {
        generation: String,
    },
    /// Explicit session removal, including a retained previous-page surface.
    CloseView { view: String },
    CloseAllViews {},
    RetireView {
        view: String,
        token: Option<String>,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub seq: u64,
    pub epoch: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub window: String,
    pub origin: String,
    pub service: String,
    pub target: String,
    pub epoch: String,
}
impl Context {
    pub fn validate(&self) -> Result<(), String> {
        for value in [
            &self.window,
            &self.origin,
            &self.service,
            &self.target,
            &self.epoch,
        ] {
            validate_id(value)?;
        }
        Ok(())
    }
}
pub fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err("Invalid native owner metadata".into());
    }
    Ok(())
}
/// The original durable cache accounts the entire JSON entry in UTF-16 bytes.
/// Stop outer serialization at its bound before retaining a host cache copy.
pub fn snapshot_fits_entry(snapshot: &termdock_native_terminal::core::DurableSnapshot) -> bool {
    struct Bounded(Vec<u8>);
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.0.len() + bytes.len() > 256 * 1024 {
                return Err(std::io::Error::other("snapshot entry exceeds its bound"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Bounded(Vec::with_capacity(256 * 1024));
    if serde_json::to_writer(&mut writer, snapshot).is_err() {
        return false;
    }
    let Ok(json) = std::str::from_utf8(&writer.0) else {
        return false;
    };
    // Reserve the local savedAt field's worst safe integer text too.
    json.encode_utf16().count() * 2 + 64 <= 256 * 1024
}
/// Convert measured CSS viewport coordinates to the WKWebView's actual AppKit
/// bounds. Browser zoom is represented by the ratio, backing scale by AppKit.
/// NSView's flipping is handled in TDGhostty; no page-supplied device scale.
pub fn rect_in_host(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport: (f64, f64),
    host: (f64, f64),
) -> Result<(f64, f64, f64, f64), String> {
    if ![x, y, width, height, viewport.0, viewport.1, host.0, host.1]
        .iter()
        .all(|v| v.is_finite())
        || viewport.0 <= 0.
        || viewport.1 <= 0.
        || host.0 <= 0.
        || host.1 <= 0.
        || width <= 0.
        || height <= 0.
        || x < 0.
        || y < 0.
        || x + width > viewport.0 + 0.5
        || y + height > viewport.1 + 0.5
    {
        return Err("Native rect must be clipped to its measured viewport".into());
    }
    Ok((
        x * host.0 / viewport.0,
        y * host.1 / viewport.1,
        width * host.0 / viewport.0,
        height * host.1 / viewport.1,
    ))
}
/// Page zoom is host-owned. A width ratio from different resize generations
/// cannot be used as a font setting. Permit only CSS-pixel rounding here.
pub fn viewport_matches_host(viewport:(f64,f64),host:(f64,f64),zoom:f64)->bool {
    [viewport.0,viewport.1,host.0,host.1,zoom].iter().all(|v|v.is_finite()&&*v>0.)
        && (0.5..=3.).contains(&zoom)
        && (host.0-viewport.0*zoom).abs()<=zoom.max(1.)+0.5
        && (host.1-viewport.1*zoom).abs()<=zoom.max(1.)+0.5
}
/// A fresh receiver must not inherit the replaced NSView's presentation.
pub fn reset_surface_presentation<T>(rect: &mut Option<T>, visible: &mut bool, clip_generation: &mut Option<String>) {
    *rect = None;
    *visible = false;
    *clip_generation = None;
}
/// Native set_layout hides on failure. Keep the host mirror conservative too.
pub fn confirm_layout_visibility(visible: &mut bool, result: Result<(), String>) -> Result<(), String> {
    if result.is_err() { *visible = false; }
    result
}
/// Convert viewport overlay cutouts into one panel's local AppKit points.
/// Inputs are bounded public geometry; the native host/window remains implicit.
pub fn overlay_holes_in_panel(holes:&[[f64;4]],viewport:(f64,f64),host:(f64,f64,f64,f64),panel:(f64,f64,f64,f64))->Result<Vec<[f64;4]>,String>{
    if holes.len()>64||![viewport.0,viewport.1,host.0,host.1,host.2,host.3,panel.0,panel.1,panel.2,panel.3].iter().all(|v|v.is_finite())
        ||viewport.0<=0.||viewport.1<=0.||host.2<=0.||host.3<=0.||panel.2<0.||panel.3<0. {
        return Err("Invalid native overlay viewport or panel geometry".into());
    }
    let mut clipped=Vec::new();
    for hole in holes {
        if hole.iter().any(|v|!v.is_finite())||hole[2]<0.||hole[3]<0.||!(hole[0]+hole[2]).is_finite()||!(hole[1]+hole[3]).is_finite(){return Err("Invalid native overlay rectangle".into());}
        let left=hole[0].max(0.);let top=hole[1].max(0.);
        let right=(hole[0]+hole[2]).min(viewport.0);let bottom=(hole[1]+hole[3]).min(viewport.1);
        if right<=left||bottom<=top{continue;}
        let (x,y,w,h)=rect_in_host(left,top,right-left,bottom-top,viewport,(host.2,host.3))?;
        let left=(host.0+x-panel.0).max(0.);let top=(host.1+y-panel.1).max(0.);
        let right=(host.0+x-panel.0+w).min(panel.2);let bottom=(host.1+y-panel.1+h).min(panel.3);
        if right>left&&bottom>top{clipped.push([left,top,right-left,bottom-top]);}
    }
    Ok(clipped)
}

#[cfg(test)]
mod tests {
    #[test]
    fn replacement_before_first_rect_has_no_geometry_or_visible_state_for_overlay_prepare() {
        let mut rect=Some((10.,20.,200.,100.));let mut visible=true;let mut generation=Some("old".into());
        reset_surface_presentation(&mut rect,&mut visible,&mut generation);
        assert!(rect.is_none());assert!(!visible);assert!(generation.is_none());
        // Both production replacement branches must use this reset, before bind
        // can fail and before a subsequent PrepareOverlay can inspect the entry.
        let source=include_str!("native_terminal.rs");
        for (start,end) in [("Request::LocalReset{..}=>{", "Request::Restore{snapshot,..}=>{"),("Request::Restore{snapshot,..}=>{", "Request::Write{sequence,")] {
            let branch=source.split_once(start).unwrap().1.split_once(end).unwrap().0;
            let reset=branch.find("native_contract::reset_surface_presentation(").unwrap();
            assert!(reset<branch.find("entry.panel.bind_webview(").unwrap());
        }
    }
    #[test]
    fn failed_layout_cannot_supply_visible_true_to_a_following_overlay_prepare() {
        let mut visible=true;
        assert_eq!(confirm_layout_visibility(&mut visible,Err("layout failed".into())),Err("layout failed".into()));
        assert!(!visible);
        confirm_layout_visibility(&mut visible,Ok(())).unwrap();
        assert!(!visible,"mask-only success must not make a hidden receiver visible");
    }
    #[test]
    fn local_reset_requires_only_an_owned_capability_and_rejects_invented_cursor_or_parser_commands() {
        assert!(matches!(serde_json::from_value::<super::Request>(serde_json::json!({"action":"localReset","token":"owned"})).unwrap(),super::Request::LocalReset{..}));
        for field in ["cursor","base64","session","handle"] {let mut args=serde_json::json!({"action":"localReset","token":"owned"});args[field]=serde_json::json!("untrusted");assert!(serde_json::from_value::<super::Request>(args).is_err());}
    }
    use super::*;
    #[test]
    fn rejects_native_pointers_and_identity_overrides() {
        for field in ["parent", "target", "window", "path", "epoch", "service", "token"] {
            let mut value = serde_json::json!({"action":"hideAll","generation":"overlay1"});
            value[field] = serde_json::json!("spoof");
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        assert!(validate_id("a\0b").is_err());
    }
    #[test]
    fn rect_layout_fields_are_optional_for_legacy_calls_and_bound_to_overlay_generation() {
        let base=serde_json::json!({"action":"rect","token":"owned","x":0,"y":0,"width":100,"height":80,"viewportWidth":800,"viewportHeight":600});
        assert!(matches!(serde_json::from_value::<Request>(base.clone()).unwrap(),Request::Rect{holes:None,generation:None,..}));
        let mut layout=base;layout["holes"]=serde_json::json!([[10,20,30,40]]);layout["generation"]=serde_json::json!("overlay-7");
        assert!(matches!(serde_json::from_value::<Request>(layout).unwrap(),Request::Rect{holes:Some(holes),generation:Some(generation),..} if holes==vec![[10.,20.,30.,40.]]&&generation=="overlay-7"));
        let prepare=serde_json::json!({"action":"prepareOverlay","generation":"overlay-8","viewportWidth":800,"viewportHeight":600,"holes":[[10,20,30,40]]});
        assert!(matches!(serde_json::from_value::<Request>(prepare).unwrap(),Request::PrepareOverlay{generation,viewport_width,viewport_height,holes} if generation=="overlay-8"&&viewport_width==800.&&viewport_height==600.&&holes==vec![[10.,20.,30.,40.]]));
    }
    #[test]
    fn first_overlay_cutouts_are_clipped_per_native_panel_without_changing_visibility(){
        let holes=overlay_holes_in_panel(&[[100.,50.,100.,50.],[500.,450.,100.,80.]],(800.,600.),(10.,20.,800.,600.),(110.,70.,200.,100.)).unwrap();
        assert_eq!(holes,vec![[0.,0.,100.,50.]]);
        assert!(overlay_holes_in_panel(&[[f64::NAN,0.,1.,1.]],(800.,600.),(0.,0.,800.,600.),(0.,0.,200.,100.)).is_err());
    }
    #[test]
    fn coordinates_use_actual_host_and_reject_overflow() {
        assert_eq!(
            rect_in_host(10., 20., 100., 200., (500., 500.), (750., 750.)).unwrap(),
            (15., 30., 150., 300.)
        );
        assert!(rect_in_host(-1., 0., 1., 2., (10., 10.), (10., 10.)).is_err());
        assert!(rect_in_host(0., 0., 11., 2., (10., 10.), (10., 10.)).is_err());
        assert!(rect_in_host(0., 0., 1., 2., (f64::NAN, 10.), (10., 10.)).is_err());
    }
}

/// Disjoint union strips prevent even-odd layer masks from exposing the overlap
/// of two DOM overlays (or duplicate portal/backdrop rectangles).
pub fn union_rectangles(holes: &[[f64; 4]]) -> Result<Vec<[f64; 4]>, String> {
    if holes.len() > 64 || holes.iter().flatten().any(|value| !value.is_finite()) {
        return Err("Invalid native clip geometry".into());
    }
    let mut edges = Vec::with_capacity(holes.len() * 2);
    for r in holes {
        if r[2] < 0. || r[3] < 0. {
            return Err("Invalid native clip shape".into());
        }
        edges.push(r[1]);
        edges.push(r[1] + r[3]);
    }
    edges.sort_by(f64::total_cmp);
    edges.dedup();
    let mut output = Vec::new();
    for pair in edges.windows(2) {
        let y = pair[0];
        let end = pair[1];
        if end <= y {
            continue;
        }
        let mut spans = holes
            .iter()
            .filter(|r| r[1] <= y && r[1] + r[3] >= end && r[2] > 0.)
            .map(|r| (r[0], r[0] + r[2]))
            .collect::<Vec<_>>();
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut current: Option<(f64, f64)> = None;
        for (left, right) in spans {
            match current {
                Some((start, last)) if left <= last => current = Some((start, last.max(right))),
                Some((start, last)) => {
                    output.push([start, y, last - start, end - y]);
                    current = Some((left, right));
                }
                None => current = Some((left, right)),
            }
        }
        if let Some((left, right)) = current {
            output.push([left, y, right - left, end - y]);
        }
    }
    if output.len() > 8192 {
        return Err("Native clip union exceeded its budget".into());
    }
    Ok(output)
}
#[cfg(test)]
mod clip_tests {
    use super::*;
    #[test]
    fn overlap_and_duplicate_overlay_holes_are_a_union_not_xor() {
        let rects = union_rectangles(&[
            [0., 0., 100., 100.],
            [50., 50., 100., 100.],
            [0., 0., 100., 100.],
        ])
        .unwrap();
        for (x, y, expected) in [
            (25., 25., true),
            (75., 75., true),
            (125., 125., true),
            (125., 25., false),
        ] {
            assert_eq!(
                rects
                    .iter()
                    .filter(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
                    .count(),
                usize::from(expected)
            );
        }
        assert!(union_rectangles(&[[0., 0., f64::NAN, 1.]]).is_err());
    }
}
#[cfg(test)]
mod snapshot_budget_tests {
    use super::*;
    #[test]
    fn whole_entry_counts_both_json_layers_and_header_in_the_original_utf16_budget() {
        let mut snapshot:termdock_native_terminal::core::DurableSnapshot=serde_json::from_value(serde_json::json!({
            "version":1,"engine":termdock_native_terminal::core::ENGINE,
            "owner":{"service":"https://service.test","target":"target","session":"backend","device":"device","window":"window","view":"panel","epoch":"page"},
            "options":{"columns":80,"rows":24,"history":1000,"font":{"family":"Test","features":[]},"palette":{"ansi":vec![[0,0,0];16],"foreground":[0,0,0],"background":[0,0,0],"cursor":[0,0,0],"selection":[0,0,0]}},
            "font_size":13.,"data":"ok","data_sha256":"0".repeat(64),"cursor":{"seq":1,"epoch":"stream"}
        })).unwrap();
        snapshot.data = "a".repeat(64 * 1024);
        assert!(snapshot_fits_entry(&snapshot));
        snapshot.data = "a".repeat(128 * 1024);
        assert!(!snapshot_fits_entry(&snapshot));
        snapshot.data = "\x1b".repeat(64 * 1024);
        assert!(!snapshot_fits_entry(&snapshot));
    }
}

#[cfg(test)]
mod resize_generation_tests {
    use super::viewport_matches_host;
    #[test]
    fn live_window_resize_cannot_masquerade_as_page_zoom() {
        assert!(viewport_matches_host((1000.,800.),(1000.,800.),1.));
        assert!(!viewport_matches_host((1000.,800.),(900.,800.),1.));
        assert!(!viewport_matches_host((900.,800.),(1000.,800.),1.));
        assert!(!viewport_matches_host((1000.,800.),(1000.,700.),1.));
        assert!(viewport_matches_host((900.,700.),(900.,700.),1.));
    }
    #[test]
    fn explicit_zoom_allows_pixel_rounding_but_rejects_stale_geometry() {
        assert!(viewport_matches_host((666.,533.),(1000.,800.),1.5));
        assert!(!viewport_matches_host((666.,533.),(900.,800.),1.5));
        assert!(!viewport_matches_host((1000.,800.),(1000.,800.),1.5));
        assert!(!viewport_matches_host((f64::NAN,800.),(1000.,800.),1.));
    }
}

/// Claim a single OS copy gesture before touching the local clipboard.
pub fn claim_copy(grant: &mut Option<(String, std::time::Instant)>, id: &str, text: &str, now: std::time::Instant) -> Result<(), String> {
    if !grant.as_ref().is_some_and(|(issued, until)| issued == id && *until > now) {
        return Err("Clipboard copy gesture expired or belongs to another terminal".into());
    }
    *grant = None;
    if text.is_empty() || text.len() > 256 * 1024 {return Err("Clipboard copy text must be 1..256KiB".into());}
    Ok(())
}
#[cfg(test)]
mod clipboard_copy_tests {
    use super::claim_copy;
    use std::time::{Instant, Duration};
    #[test]
    fn only_a_live_matching_gesture_can_write_and_only_once() {
        let now=Instant::now();let mut grant=Some(("owned".into(),now+Duration::from_secs(10)));
        assert!(claim_copy(&mut grant,"other","text",now).is_err());
        assert!(claim_copy(&mut grant,"owned","中文",now).is_ok());
        assert!(claim_copy(&mut grant,"owned","text",now).is_err());
        let mut expired=Some(("owned".into(),now));assert!(claim_copy(&mut expired,"owned","text",now).is_err());
    }
    #[test]
    fn invalid_text_is_rejected_before_any_write_and_consumes_the_gesture() {
        for text in [String::new(),"中".repeat(90_000)] {
            let now=Instant::now();let mut grant=Some(("owned".into(),now+Duration::from_secs(10)));
            assert!(claim_copy(&mut grant,"owned",&text,now).is_err());assert!(grant.is_none());
        }
    }
}
