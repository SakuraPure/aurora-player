mod library;
mod ncm;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(ncm::Ncm::new())
    .manage(library::Library::default())
    .invoke_handler(tauri::generate_handler![ncm_call, local_scan])
    // 本地音频流 / 内嵌封面：读文件放到后台线程，不阻塞界面
    .register_asynchronous_uri_scheme_protocol("media", |ctx, req, responder| {
      let app = ctx.app_handle().clone();
      std::thread::spawn(move || responder.respond(app.state::<library::Library>().media(&req)));
    })
    .register_asynchronous_uri_scheme_protocol("cover", |ctx, req, responder| {
      let app = ctx.app_handle().clone();
      std::thread::spawn(move || responder.respond(app.state::<library::Library>().cover(&req)));
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
