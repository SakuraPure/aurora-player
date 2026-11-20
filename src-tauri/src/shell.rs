//! 桌面外壳：系统托盘、关闭到托盘、迷你模式；窗口大小 / 位置由 window-state 插件记忆。
//! 播放控制类的托盘菜单通过 "tray" 事件交给前端播放器处理；迷你模式切换后发 "mini" 事件让前端换布局。

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};

/// 迷你窗口尺寸（逻辑像素）与普通窗口的最小尺寸
const MINI: (f64, f64) = (400.0, 96.0);
const NORMAL_MIN: (f64, f64) = (900.0, 600.0);

#[derive(Default)]
pub struct Mini {
    on: Mutex<bool>,
    /// 进入迷你模式前的位置、尺寸、是否最大化（退出时恢复）
    normal: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>, bool)>>,
    /// 迷你窗口上次所在位置（本次运行内记住）
    pos: Mutex<Option<PhysicalPosition<i32>>>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn is_mini(app: &AppHandle) -> bool {
    *app.state::<Mini>().on.lock().unwrap()
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        set_page_visible(&w, true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 告诉 WebView2 页面是否可见。Tauri 隐藏 / 最小化窗口时不会通知它，页面照常按显示器刷新率渲染；
/// 设为不可见后页面进入 hidden 状态：动画帧停止、计时器节流，音乐照常播放。
fn set_page_visible(w: &WebviewWindow, visible: bool) {
    #[cfg(windows)]
    let _ = w.with_webview(move |wv| unsafe {
        let _ = wv.controller().SetIsVisible(visible);
    });
    #[cfg(not(windows))]
    let _ = (w, visible);
}

/// 窗口隐藏、最小化、还原后同步页面可见性
pub fn sync_page_visible(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let visible = w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false);
        set_page_visible(&w, visible);
    }
}

/// 迷你窗口默认放在当前屏幕工作区（不含任务栏）的右下角
fn default_corner(w: &WebviewWindow) -> Option<PhysicalPosition<i32>> {
    let m = w.current_monitor().ok()??;
    let (area, k) = (m.work_area(), m.scale_factor());
    let (ww, hh, gap) = ((MINI.0 * k) as i32, (MINI.1 * k) as i32, (24.0 * k) as i32);
    Some(PhysicalPosition::new(
        area.position.x + area.size.width as i32 - ww - gap,
        area.position.y + area.size.height as i32 - hh - gap,
    ))
}

pub fn set_mini(app: &AppHandle, on: bool) -> tauri::Result<()> {
    let Some(w) = main_window(app) else { return Ok(()) };
    let st = app.state::<Mini>();
    {
        let mut cur = st.on.lock().unwrap();
        if *cur == on {
            drop(cur);
            show_main(app);
            return Ok(());
        }
        *cur = on;
    }
    let _ = app.emit("mini", on);
    if on {
        let maximized = w.is_maximized()?;
        *st.normal.lock().unwrap() = Some((w.outer_position()?, w.inner_size()?, maximized));
        if maximized {
            w.unmaximize()?;
        }
        w.set_min_size(Some(Size::Logical(LogicalSize::new(MINI.0, MINI.1))))?;
        w.set_size(Size::Logical(LogicalSize::new(MINI.0, MINI.1)))?;
        w.set_resizable(false)?;
        w.set_always_on_top(true)?;
        let pos = (*st.pos.lock().unwrap()).or_else(|| default_corner(&w));
        if let Some(p) = pos {
            w.set_position(Position::Physical(p))?;
        }
    } else {
        *st.pos.lock().unwrap() = w.outer_position().ok();
        w.set_always_on_top(false)?;
        w.set_resizable(true)?;
        w.set_min_size(Some(Size::Logical(LogicalSize::new(NORMAL_MIN.0, NORMAL_MIN.1))))?;
        if let Some((p, s, max)) = st.normal.lock().unwrap().take() {
            w.set_size(Size::Physical(s))?;
            w.set_position(Position::Physical(p))?;
            if max {
                w.maximize()?;
            }
        }
    }
    show_main(app);
    Ok(())
}

/// 真正退出：先退出迷你模式，让 window-state 记下的是普通窗口的大小和位置
pub fn quit(app: &AppHandle) {
    if is_mini(app) {
        let _ = set_mini(app, false);
    }
    app.exit(0);
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let menu = Menu::with_items(
        app,
        &[
            &item("toggle", "播放 / 暂停")?,
            &item("prev", "上一首")?,
            &item("next", "下一首")?,
            &PredefinedMenuItem::separator(app)?,
            &item("mini", "迷你模式 / 完整窗口")?,
            &item("show", "显示主窗口")?,
            &PredefinedMenuItem::separator(app)?,
            &item("tour", "使用教程")?,
            &item("update", "检查更新")?,
            &item("quit", "退出 AURORA")?,
        ],
    )?;
    // Windows：左键显示主窗口、右键弹菜单；macOS 菜单栏图标的习惯是单击直接弹菜单
    let mut tray = TrayIconBuilder::with_id("main").tooltip("AURORA").menu(&menu).show_menu_on_left_click(cfg!(target_os = "macos"));
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(tray_template()).icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, e| match e.id().as_ref() {
        "mini" => {
            let on = !is_mini(app);
            let _ = set_mini(app, on);
        }
        "show" => show_main(app),
        "quit" => quit(app),
        id => {
            if id == "update" || id == "tour" {
                show_main(app); // 检查结果、教程显示在窗口里
            }
            let _ = app.emit("tray", id); // 播放控制 / 检查更新 / 使用教程交给前端
        }
    })
    // 左键单击托盘图标：显示主窗口（macOS 单击是弹菜单，不再额外弹窗口）
    .on_tray_icon_event(|tray, e| {
        if cfg!(target_os = "macos") {
            return;
        }
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

/// macOS 菜单栏图标：与应用图标一致的四根音柱，单色模板图（系统按深浅色模式自动着色）
#[cfg(target_os = "macos")]
fn tray_template() -> tauri::image::Image<'static> {
    const S: u32 = 36; // 18pt @2x
    let mut px = vec![0u8; (S * S * 4) as usize];
    for (i, h) in [0.40f32, 0.90, 0.60, 0.75].into_iter().enumerate() {
        let x0 = 4 + i as u32 * 8; // 宽 5、间隔 3
        let top = 30 - (26.0 * h) as u32; // 底边对齐在 y = 30
        for y in top..30 {
            for x in x0..x0 + 5 {
                px[((y * S + x) * 4 + 3) as usize] = 255; // 模板图只看不透明度
            }
        }
    }
    tauri::image::Image::new_owned(px, S, S)
}

/// tauri.conf.json 里配置的更新源（为空表示还没有发布渠道）
pub fn update_endpoints(app: &AppHandle) -> Vec<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}
