// DunCrew Tauri Application
// 主入口：管理 Python 后端 Sidecar 进程 + OpenClaw 扩展自动部署

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

// 存储后端进程句柄
struct ServerState {
    child: Mutex<Option<CommandChild>>,
}

// ============================================
// OpenClaw Extension 自动部署
// ============================================

/// 获取 OpenClaw extensions 目标目录: ~/.openclaw/extensions/ddos/
fn get_openclaw_extension_target() -> Option<PathBuf> {
    Some(PathBuf::from(r"D:\编程\DunCrew-Data\.openclaw\extensions\duncrew"))
}

/// 读取 package.json 中的 version 字段
fn read_package_version(dir: &PathBuf) -> Option<String> {
    let pkg_path = dir.join("package.json");
    let content = std::fs::read_to_string(&pkg_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
    parsed.get("version")?.as_str().map(|s| s.to_string())
}

/// 递归复制目录内容
fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create dir {:?}: {}", dst, e))?;

    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {:?}: {}", src, e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {:?} -> {:?}: {}", src_path, dst_path, e))?;
        }
    }
    Ok(())
}

/// 部署捆绑的 OpenClaw 扩展到 ~/.openclaw/extensions/ddos/
/// 如果目标不存在或版本不同则复制，否则跳过。
fn install_openclaw_extension(app: &AppHandle) {
    // 1. 定位捆绑的扩展资源
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[DunCrew] Cannot resolve resource dir: {}", e);
            return;
        }
    };
    let bundled_ext = resource_dir.join("openclaw-extension");
    if !bundled_ext.exists() {
        println!("[DunCrew] No bundled openclaw-extension found, skipping auto-deploy");
        return;
    }

    // 2. 确定目标路径
    let target_dir = match get_openclaw_extension_target() {
        Some(dir) => dir,
        None => {
            eprintln!("[DunCrew] Cannot determine home directory, skipping extension deploy");
            return;
        }
    };

    // 3. 版本比较 —— 相同则跳过
    let bundled_version = read_package_version(&bundled_ext);
    let installed_version = read_package_version(&target_dir);

    if bundled_version.is_some() && bundled_version == installed_version {
        println!(
            "[DunCrew] OpenClaw extension v{} already installed, skipping",
            bundled_version.unwrap()
        );
        return;
    }

    // 4. 执行复制
    println!(
        "[DunCrew] Deploying OpenClaw extension: {:?} -> {:?}",
        bundled_ext, target_dir
    );
    match copy_dir_recursive(&bundled_ext, &target_dir) {
        Ok(()) => {
            println!("[DunCrew] OpenClaw extension deployed successfully");
            if let Some(v) = bundled_version {
                println!("[DunCrew] Installed version: {}", v);
            }
        }
        Err(e) => {
            eprintln!("[DunCrew] Failed to deploy extension: {}", e);
        }
    }
}

// ============================================
// Python Backend Sidecar
// ============================================

// 启动后端服务器
fn start_backend(app: &AppHandle) -> Result<CommandChild, String> {
    let shell = app.shell();

    // 使用固定数据目录 (已从 C 盘迁移到 D 盘)
    let data_dir = PathBuf::from(r"D:\编程\DunCrew-Data");

    // 确保数据目录存在
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    let data_path = data_dir.to_string_lossy().to_string();

    println!("[DunCrew] Starting backend server...");
    println!("[DunCrew] Data directory: {}", data_path);

    // 启动 Sidecar 进程
    let (mut rx, child) = shell
        .sidecar("duncrew-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(["--path", &data_path, "--port", "3001"])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // 异步读取输出
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    println!("[Backend] {}", line_str);
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[Backend Error] {}", line_str);
                }
                CommandEvent::Error(err) => {
                    eprintln!("[Backend] Process error: {}", err);
                }
                CommandEvent::Terminated(payload) => {
                    println!("[Backend] Process terminated with code: {:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    println!("[DunCrew] Backend server started on http://localhost:3001");
    Ok(child)
}

// 停止后端服务器
fn stop_backend(state: &ServerState) {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(child) = child_guard.take() {
        println!("[DunCrew] Stopping backend server...");
        let _ = child.kill();
        println!("[DunCrew] Backend server stopped");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 1. 自动部署 OpenClaw 扩展
            install_openclaw_extension(&app.handle());

            // 2. 启动后端服务器
            match start_backend(&app.handle()) {
                Ok(child) => {
                    app.manage(ServerState {
                        child: Mutex::new(Some(child)),
                    });
                    println!("[DunCrew] Application started successfully");
                }
                Err(e) => {
                    eprintln!("[DunCrew] Failed to start backend: {}", e);
                    // 继续运行，用户可以手动启动后端
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 窗口关闭时停止后端
                if let Some(state) = window.try_state::<ServerState>() {
                    stop_backend(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
