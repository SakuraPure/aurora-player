mod library;
mod ncm;
mod shell;

use serde_json::Value;
use tauri::Manager;

/// 网易云接口：前端 invoke('ncm_call', { fnName, params, cookie })，与 Web 版中间层的接口名 / 参数一致
#[tauri::command]
async fn ncm_call(state: tauri::State<'_, ncm::Ncm>, fn_name: String, params: Value, cookie: String) -> Result<Value, String> {
  let res = state.call(&fn_name, &params, &cookie).await;
  log::info!("ncm_call {fn_name} -> {}", if res.is_ok() { "ok" } else { "err" });
  res
}

/// 本地曲库：扫描已添加的文件夹 / 文件，返回带标签信息的曲目
#[tauri::command]
async fn local_scan(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<library::LocalTrack>, String> {
  let n = paths.len();
  let tracks = tauri::async_runtime::spawn_blocking(move || app.state::<library::Library>().scan(paths))
    .await
    .map_err(|e| e.to_string())?;
  log::info!("local_scan {n} paths -> {} tracks", tracks.len());
  Ok(tracks)
}

/// 迷你模式开关（托盘菜单也能切换；切换后都会发 "mini" 事件）
#[tauri::command]
fn mini_mode(app: tauri::AppHandle, on: bool) -> Result<(), String> {
  shell::set_mini(&app, on).map_err(|e| e.to_string())
}

/// 托盘悬停提示：当前歌曲
#[tauri::command]
fn tray_tooltip(app: tauri::AppHandle, text: String) {
  if let Some(t) = app.tray_by_id("main") {
    let _ = t.set_tooltip(Some(text));
  }
}

/// 已配置的更新源；为空时前端不去检查更新
#[tauri::command]
fn update_source(app: tauri::AppHandle) -> Vec<String> {
  shell::update_endpoints(&app)
}

/// 真正退出（关闭按钮只是隐藏到托盘）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
  shell::quit(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  use tauri_plugin_window_state::StateFlags;
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    // 记住窗口大小、位置、是否最大化；显示与否由我们自己控制（托盘隐藏不应被"记住"）
    .plugin(
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS)
        .build(),
    )
    .manage(ncm::Ncm::new())
    .manage(library::Library::default())
    .manage(shell::Mini::default())
    .invoke_handler(tauri::generate_handler![ncm_call, local_scan, mini_mode, tray_tooltip, update_source, quit_app])
    // 本地音频流 / 内嵌封面：读文件放到后台线程，不阻塞界面
    .register_asynchronous_uri_scheme_protocol("media", |ctx, req, responder| {
      let app = ctx.app_handle().clone();
      std::thread::spawn(move || responder.respond(app.state::<library::Library>().media(&req)));
    })
    .register_asynchronous_uri_scheme_protocol("cover", |ctx, req, responder| {
      let app = ctx.app_handle().clone();
      std::thread::spawn(move || responder.respond(app.state::<library::Library>().cover(&req)));
    })
    // 关闭窗口 = 隐藏到托盘，音乐继续播放；托盘菜单"退出"才真正退出
    .on_window_event(|w, e| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = e {
        if w.label() == "main" {
          api.prevent_close();
          let _ = w.hide();
        }
      }
    })
    .setup(|app| {
      #[cfg(desktop)]
      {
        app.handle().plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
        shell::create_tray(app.handle())?;
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // 窗口配置为先隐藏：window-state 恢复好上次的大小位置后再显示，避免跳动
      shell::show_main(app.handle());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app, event| {
    // 任何方式退出（包括系统关机注销）时若还在迷你模式，先恢复普通窗口，保证记住的是普通窗口的大小位置
    if let tauri::RunEvent::ExitRequested { .. } = event {
      if shell::is_mini(app) {
        let _ = shell::set_mini(app, false);
      }
    }
  });
}
