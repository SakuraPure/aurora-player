mod ncm;

use serde_json::Value;

/// 网易云接口：前端 invoke('ncm_call', { fnName, params, cookie })，与 Web 版中间层的接口名 / 参数一致
#[tauri::command]
async fn ncm_call(state: tauri::State<'_, ncm::Ncm>, fn_name: String, params: Value, cookie: String) -> Result<Value, String> {
  let res = state.call(&fn_name, &params, &cookie).await;
  log::info!("ncm_call {fn_name} -> {}", if res.is_ok() { "ok" } else { "err" });
  res
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(ncm::Ncm::new())
    .invoke_handler(tauri::generate_handler![ncm_call])
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
