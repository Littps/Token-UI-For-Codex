use std::process::ExitCode;

use tokens_ui_launcher::config::LauncherOptions;
use tokens_ui_launcher::supervisor::{diagnose, stop_supervisor};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        print_help();
        return ExitCode::SUCCESS;
    }
    let command = args.remove(0);
    let options = match LauncherOptions::from_args(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error:#}");
            return ExitCode::from(2);
        }
    };
    match command.as_str() {
        "--status" | "--diagnose" | "--check" => match diagnose(&options) {
            Ok(report) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                );
                if report.errors.is_empty() {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                }
            }
            Err(error) => {
                eprintln!("{error:#}");
                ExitCode::from(1)
            }
        },
        "--stop" => match stop_supervisor(&options) {
            Ok(()) => {
                println!("stopped");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("{error:#}");
                ExitCode::from(1)
            }
        },
        "--help" | "-h" => {
            print_help();
            ExitCode::SUCCESS
        }
        "--version" | "-V" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        unknown => {
            eprintln!("unknown doctor command: {unknown}");
            print_help();
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    println!(
        "tokens-ui-doctor {}\n\
         Usage: tokens-ui-doctor <--status|--check|--diagnose|--stop> [options]\n\
         Options: --plugin-root <dir> --node <node.exe> --script <token-stats.mjs>",
        env!("CARGO_PKG_VERSION")
    );
}
