use crate::{
    config::{Point, WindowState},
    shell::{self, state},
};
use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    let shell = state(app);
    let labels = shell
        .windows
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    labels
        .iter()
        .filter_map(|l| app.get_webview_window(l))
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| {
            shell
                .last_focused
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|l| app.get_webview_window(l))
        })
        .or_else(|| labels.first().and_then(|l| app.get_webview_window(l)))
}
pub fn focus(window: &WebviewWindow) -> Result<(), String> {
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
pub fn emit(window: &WebviewWindow, event: &str, detail: Value) {
    let _ = window.eval(&format!(
        "window.dispatchEvent(new CustomEvent({},{{detail:{detail}}}));",
        json!(event)
    ));
}
pub fn summary(app: &AppHandle, recipient: Option<&str>) -> Value {
    let shell = state(app);
    let rows = shell
        .windows
        .lock()
        .unwrap()
        .iter()
        .map(|(label, w)| (label.clone(), w.connection.clone(), w.activity.clone()))
        .collect::<Vec<_>>();
    let mut running = 0;
    let mut review = 0;
    let services=rows.iter().map(|(label,c,a)|{
        let r=a["runningCount"].as_u64().unwrap_or(0);let v=a["reviewCount"].as_u64().unwrap_or(0);running+=r;review+=v;
        json!({"origin":c.service_origin.as_ref().unwrap_or(&c.url),"targetPeerId":c.target_peer_id,"label":c.label,"runningCount":r,"reviewCount":v,"current":recipient==Some(label.as_str()),"focused":app.get_webview_window(label).is_some_and(|w|w.is_focused().unwrap_or(false))})
    }).collect::<Vec<_>>();
    let mut parts = vec![];
    if running > 0 {
        parts.push(format!("运{running}"));
    }
    if review > 0 {
        parts.push(format!("待{review}"));
    }
    parts.push(format!("服{}", services.len()));
    let text = parts.join(" ");
    let tooltip = services
        .iter()
        .map(|s| {
            format!(
                "{}：运行{}，待办{}",
                s["label"].as_str().unwrap_or(""),
                s["runningCount"],
                s["reviewCount"]
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    json!({"runningCount":running,"reviewCount":review,"serviceCount":services.len(),"text":text,"tooltip":tooltip,"services":services,"preferences":shell.config.lock().unwrap().desktop_preferences})
}
pub fn publish(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let value = summary(app, Some(window.label()));
        emit(
            window,
            "termdock:preview-activity",
            value["services"].clone(),
        );
        emit(window, "termdock:preview-status", value);
    }
    if let Err(error) = refresh_tray(app) {
        eprintln!("Preview tray: {error}");
    }
}
pub fn next(app: &AppHandle, scope: &str) -> Result<(), String> {
    let shell = state(app);
    let labels = shell
        .windows
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, w)| match scope {
            "running" => w.activity["runningCount"].as_u64().unwrap_or(0) > 0,
            "review" => w.activity["reviewCount"].as_u64().unwrap_or(0) > 0,
            "attention" => w.activity["reviewCount"].as_u64().unwrap_or(0) > 0,
            _ => true,
        })
        .map(|(l, _)| l.clone())
        .collect::<Vec<_>>();
    if labels.is_empty() {
        if scope == "attention" {
            return next(app, "all");
        }
        if scope != "all" {
            return next(app, "all");
        }
        return shell::show_center(app);
    }
    let current = focused(app).map(|w| w.label().to_owned());
    let index = current
        .and_then(|c| labels.iter().position(|l| l == &c))
        .map_or(0, |i| (i + 1) % labels.len());
    if let Some(w) = app.get_webview_window(&labels[index]) {
        focus(&w)?;
    }
    Ok(())
}
pub fn install_menu(app: &AppHandle) -> Result<(), String> {
    let commands: Vec<Value> = serde_json::from_str(include_str!("../../renderer/commands.json"))
        .map_err(|e| e.to_string())?;
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    let application = Submenu::new(app, crate::product::name(), true).map_err(|e| e.to_string())?;
    application
        .append(
            &PredefinedMenuItem::about(app, Some(&format!("About {}", crate::product::name())), None)
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    application
        .append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for group in ["应用", "文件", "编辑", "显示", "窗口"] {
        let submenu = if group == "应用" {
            application.clone()
        } else {
            Submenu::new(app, group, true).map_err(|e| e.to_string())?
        };
        for row in commands.iter().filter(|r| r["menu"] == group) {
            if matches!(
                row["id"].as_str(),
                Some("previous-session" | "previous-attention" | "reload" | "reset-zoom")
            ) {
                submenu
                    .append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            }
            submenu
                .append(
                    &MenuItem::with_id(
                        app,
                        row["id"].as_str().unwrap(),
                        row["label"].as_str().unwrap(),
                        true,
                        row["accelerator"].as_str(),
                    )
                    .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
        if group == "应用" || group == "窗口" {
            let services = Submenu::new(app, "打开服务", true).map_err(|e| e.to_string())?;
            let connections = state(app).config.lock().unwrap().connections.clone();
            // The opt-in fixture never reads the user's standalone daemon data.
            let local=if crate::window_diagnostics::active(){None}else{crate::local_service::metadata()};
            for row in crate::config::service_menu_rows(&connections,local.as_ref().and_then(|value|value["localUrl"].as_str())) {
                services
                    .append(
                        &MenuItem::with_id(
                            app,
                            row.id,
                            row.label,
                            true,
                            None::<&str>,
                        )
                        .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
            }
            submenu.append(&services).map_err(|e| e.to_string())?;
        }
        if group == "应用" {
            for (id, label) in [
                ("check-update", "检查更新…"),
                ("data-directory", "打开 Termdock 数据目录"),
            ] {
                submenu
                    .append(
                        &MenuItem::with_id(app, id, label, true, None::<&str>)
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(target_os = "macos")]
            {
                submenu
                    .append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                submenu
                    .append(
                        &PredefinedMenuItem::hide(app, Some(&format!("Hide {}", crate::product::name())))
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                submenu
                    .append(&PredefinedMenuItem::hide_others(app, None).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                submenu
                    .append(&PredefinedMenuItem::show_all(app, None).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            }
            submenu
                .append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            submenu
                .append(
                    &PredefinedMenuItem::quit(app, Some(&format!("Quit {}", crate::product::name())))
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
        if group == "编辑" {
            for item in [
                PredefinedMenuItem::undo(app, None),
                PredefinedMenuItem::redo(app, None),
                PredefinedMenuItem::separator(app),
                PredefinedMenuItem::cut(app, None),
                PredefinedMenuItem::copy(app, None),
                PredefinedMenuItem::paste(app, None),
                PredefinedMenuItem::select_all(app, None),
            ] {
                submenu
                    .append(&item.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            }
        }
        if group == "显示" {
            submenu
                .append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            submenu
                .append(
                    &PredefinedMenuItem::fullscreen(app, Some("Toggle Full Screen"))
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
        if group == "窗口" {
            submenu
                .append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            submenu
                .append(&PredefinedMenuItem::minimize(app, None).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            submenu
                .append(
                    &PredefinedMenuItem::maximize(app, Some("Zoom")).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            submenu
                .append(
                    &PredefinedMenuItem::bring_all_to_front(app, None)
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
        menu.append(&submenu).map_err(|e| e.to_string())?;
    }
    app.set_menu(menu).map_err(|e| e.to_string())?;
    crate::native_desktop::configure_menu(app)?;
    Ok(())
}
pub fn menu_event(app: &AppHandle, id: &str) {
    match id {
        "connection-center" | "new-connection" => {
            let _ = shell::show_center(app);
        }
        "local-service" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = shell::connect_local(&app).await;
            });
        }
        "data-directory" => {
            let _ = crate::local_service::home()
                .and_then(|h| open::that(h.join(".termdock")).map_err(|e| e.to_string()));
        }
        "check-update" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let value = app.state::<crate::updater::Updater>().check(&app).await;
                let message = if value["status"] == "ready" {
                    "更新已下载，是否重启并安装？".to_owned()
                } else if value["status"] == "current" {
                    "当前已是最新版本".into()
                } else {
                    value["error"].as_str().unwrap_or("更新检查完成").to_owned()
                };
                let answer = rfd::AsyncMessageDialog::new()
                    .set_title(format!("{} 更新", crate::product::name()))
                    .set_description(message)
                    .set_buttons(if value["status"] == "ready" {
                        rfd::MessageButtons::YesNo
                    } else {
                        rfd::MessageButtons::Ok
                    })
                    .show()
                    .await;
                if answer == rfd::MessageDialogResult::Yes {
                    app.state::<crate::updater::Updater>().install(&app).await;
                }
            });
        }
        "tray-attention" => {
            let _ = next(app, "attention");
        }
        "tray-running" => {
            let _ = next(app, "running");
        }
        "tray-all" => {
            let _ = next(app, "all");
        }
        "toggle-floating" => {
            let enabled = {
                let shell = state(app);
                let mut config = shell.config.lock().unwrap();
                config.desktop_preferences.floating_widget_enabled =
                    !config.desktop_preferences.floating_widget_enabled;
                config.desktop_preferences.floating_widget_enabled
            };
            let _ = shell::store(app);
            let _ = floating(app, enabled);
            publish(app);
        }
        value if value.starts_with("open:") => {
            let connection = state(app)
                .config
                .lock()
                .unwrap()
                .connections
                .iter()
                .find(|c| c.id == value[5..])
                .cloned();
            if let Some(c) = connection {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = shell::open_connection(&app, c, None).await {
                        let _ = shell::show_center(&app);
                        shell::announce(&app, "termdock:preview-error", json!(error));
                    }
                });
            }
        }
        id => {
            if let Some(window) = focused(app) {
                match id {
                    "settings" => emit(&window, "termdock:open-settings", Value::Null),
                    "reload" => {
                        let _ = window.eval("window.termdockDesktop?.reloadWorkspace ? void window.termdockDesktop.reloadWorkspace() : location.reload()");
                    }
                    "force-reload" => {
                        // Assets use no-store at the boundary. Refresh the signed
                        // app's current worker too; never disable background support.
                        let _=window.eval("window.termdockDesktop?.reloadWorkspace ? void window.termdockDesktop.reloadWorkspace({force:true}) : location.reload()");
                    }
                    "zoom-in" | "zoom-out" | "reset-zoom" => {
                        let shell = state(app);
                        let mut zooms = shell.zooms.lock().unwrap();
                        let zoom = zooms.entry(window.label().to_owned()).or_insert(1.);
                        *zoom = if id == "reset-zoom" {
                            1.
                        } else if id == "zoom-in" {
                            (*zoom + 0.1).min(3.)
                        } else {
                            (*zoom - 0.1).max(0.5)
                        };
                        let _ = window.set_zoom(*zoom);
                        #[cfg(target_os = "macos")]
                        shell::align_titlebar(&window, *zoom);
                    }
                    command => emit(&window, "termdock:native-command", json!(command)),
                }
            } else if id == "close-session" {
                if let Some(w) = app.get_webview_window("center") {
                    let _ = w.close();
                }
            }
        }
    }
}
fn tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for (id, label) in [
        ("tray-attention", "查看待处理"),
        ("tray-running", "查看运行中的服务"),
        ("tray-all", "切换服务"),
        ("connection-center", "连接中心"),
    ] {
        menu.append(
            &MenuItem::with_id(app, id, label, true, None::<&str>).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    let preferences = state(app)
        .config
        .lock()
        .unwrap()
        .desktop_preferences
        .clone();
    menu.append(
        &CheckMenuItem::with_id(
            app,
            "toggle-floating",
            "常驻悬浮状态",
            true,
            preferences.floating_widget_enabled,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let services = summary(app, None)["services"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let connections = state(app).config.lock().unwrap().connections.clone();
    for service in services {
        if let Some(c) = connections.iter().find(|c| {
            c.service_origin.as_ref().unwrap_or(&c.url) == service["origin"].as_str().unwrap_or("")
        }) {
            menu.append(
                &MenuItem::with_id(
                    app,
                    format!("open:{}", c.id),
                    format!(
                        "{}　运行{} 待办{}",
                        c.label, service["runningCount"], service["reviewCount"]
                    ),
                    true,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    menu.append(
        &PredefinedMenuItem::quit(app, Some(&format!("退出 {}", crate::product::name()))).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(menu)
}
pub fn refresh_tray(app: &AppHandle) -> Result<(), String> {
    let shell = state(app);
    let enabled = shell
        .config
        .lock()
        .unwrap()
        .desktop_preferences
        .menu_bar_status_enabled;
    if !enabled {
        shell.tray.lock().unwrap().take();
        return Ok(());
    }
    let status = summary(app, None);
    let menu = tray_menu(app)?;
    // Reuse the stable two-/three-row monochrome metric icon.
    let r = status["runningCount"].as_u64().unwrap_or(0);
    let v = status["reviewCount"].as_u64().unwrap_or(0);
    let s = status["serviceCount"].as_u64().unwrap_or(0);
    let image = tauri::image::Image::new_owned(crate::tray_image::bitmap(r, v, s), 18, 18);
    let existing = shell.tray.lock().unwrap().clone();
    if let Some(tray) = existing {
        tray.set_icon(Some(image.clone()))
            .map_err(|e| e.to_string())?;
        tray.set_icon_as_template(true).map_err(|e| e.to_string())?;
        tray.set_title(Some("")).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(
            status["tooltip"].as_str().unwrap_or(crate::product::name()),
        ))
        .map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    } else {
        let tray = TrayIconBuilder::with_id("preview-status")
            .icon(image)
            .icon_as_template(true)
            .tooltip(crate::product::name())
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    }
                ) {
                    let _ = next(tray.app_handle(), "attention");
                }
            })
            .build(app)
            .map_err(|e| e.to_string())?;
        *shell.tray.lock().unwrap() = Some(tray);
    }
    Ok(())
}
pub fn constrain_floating(app: &AppHandle, position: Option<Point>, width: f64) -> Option<Point> {
    let monitors = app.available_monitors().ok()?;
    let monitor = position
        .as_ref()
        .and_then(|p| {
            monitors
                .iter()
                .find(|m| {
                    let area = m.work_area();
                    let scale = m.scale_factor();
                    p.x >= area.position.x as f64 / scale
                        && p.x < (area.position.x as f64 + area.size.width as f64) / scale
                        && p.y >= area.position.y as f64 / scale
                        && p.y < (area.position.y as f64 + area.size.height as f64) / scale
                })
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let a = monitor.work_area();
    let scale = monitor.scale_factor();
    let x = a.position.x as f64 / scale;
    let y = a.position.y as f64 / scale;
    let max_x = (x + a.size.width as f64 / scale - width).max(x);
    let max_y = (y + a.size.height as f64 / scale - 40.).max(y);
    let p = position.unwrap_or(Point {
        x: max_x - 18.,
        y: y + 18.,
    });
    Some(Point {
        x: p.x.round().clamp(x, max_x),
        y: p.y.round().clamp(y, max_y),
    })
}
pub fn floating(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        if let Some(w) = app.get_webview_window("floating") {
            let _ = w.close();
        }
        return Ok(());
    }
    if app.get_webview_window("floating").is_some() {
        return Ok(());
    }
    let position = state(app)
        .config
        .lock()
        .unwrap()
        .desktop_preferences
        .floating_widget_position
        .clone();
    let position = constrain_floating(app, position, 152.);
    let mut builder =
        WebviewWindowBuilder::new(app, "floating", WebviewUrl::App("floating.html".into()))
            .title(format!("{} Status", crate::product::name()))
            .inner_size(152., 40.)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .initialization_script(shell::local_bridge())
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Started {
                    shell::page_document_started(&window);
                } else {
                    shell::publish_document_epoch(&window);
                }
            });
    if let Some(p) = position {
        builder = builder.position(p.x, p.y);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    crate::native_desktop::panel(&window);
    let app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Moved(_)) {
            if let Some(w) = app.get_webview_window("floating") {
                if let (Ok(p), Ok(scale)) = (w.outer_position(), w.scale_factor()) {
                    let point: tauri::LogicalPosition<f64> = p.to_logical(scale);
                    let width = w
                        .inner_size()
                        .map(|s| s.width as f64 / scale)
                        .unwrap_or(152.);
                    let p = constrain_floating(
                        &app,
                        Some(Point {
                            x: point.x,
                            y: point.y,
                        }),
                        width,
                    )
                    .unwrap_or(Point {
                        x: point.x,
                        y: point.y,
                    });
                    if point.x != p.x || point.y != p.y {
                        crate::window_chrome::invalidate(&w,false);
                        let _ = w.set_position(tauri::LogicalPosition::new(p.x, p.y));
                    }
                    let shell = state(&app);
                    let mut config = shell.config.lock().unwrap();
                    config.desktop_preferences.floating_widget_position = Some(p);
                    let _ = config.persist(&shell.file);
                }
            }
        }
    });
    Ok(())
}
pub fn window_bounds(app: &AppHandle, key: &str) -> Option<WindowState> {
    let shell = state(app);
    let saved = shell.config.lock().unwrap().window_states.get(key).cloned();
    let monitors = app.available_monitors().ok()?;
    let monitor = saved
        .as_ref()
        .and_then(|p| {
            monitors.iter().find(|m| {
                let a = m.work_area();
                let scale = m.scale_factor();
                p.x >= a.position.x as f64 / scale
                    && p.x < (a.position.x as f64 + a.size.width as f64) / scale
                    && p.y >= a.position.y as f64 / scale
                    && p.y < (a.position.y as f64 + a.size.height as f64) / scale
            })
        })
        .cloned()
        .or_else(|| focused(app).and_then(|w| w.current_monitor().ok().flatten()))
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let x = area.position.x as f64 / scale;
    let y = area.position.y as f64 / scale;
    let width = area.size.width as f64 / scale;
    let height = area.size.height as f64 / scale;
    Some(
        saved
            .unwrap_or(WindowState {
                x,
                y,
                width,
                height,
                fullscreen: false,
            })
            .constrained(x, y, width, height),
    )
}
