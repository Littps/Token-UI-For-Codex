#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use tokens_ui_launcher::config::LauncherOptions;
use tokens_ui_launcher::state::append_log;
use tokens_ui_launcher::supervisor::run_supervisor;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        std::process::exit(0);
    }
    let options = match LauncherOptions::from_args(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("launcher argument error: {error:#}");
            write_startup_error(&args, &error.to_string());
            std::process::exit(2);
        }
    };
    if let Err(error) = run_supervisor(options.clone()) {
        eprintln!("launcher startup error: {error:#}");
        write_startup_error(&args, &format!("{error:#}"));
        std::process::exit(1);
    }
}

fn write_startup_error(args: &[String], message: &str) {
    let plugin_root = args
        .windows(2)
        .find(|pair| pair[0] == "--plugin-root")
        .map(|pair| PathBuf::from(&pair[1]))
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(PathBuf::from))
        });
    let Some(root) = plugin_root else {
        return;
    };
    let Ok(paths) =
        LauncherOptions::from_args(&["--plugin-root".to_string(), root.display().to_string()])
            .and_then(|options| options.runtime_paths())
    else {
        return;
    };
    let _ = append_log(
        &paths.log_dir,
        &format!("launcher startup failure: {message}"),
    );
}
