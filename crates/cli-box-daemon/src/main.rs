// crates/cli-box-daemon/src/main.rs
fn main() {
    // Handle simple introspection flags before starting the runtime, so the
    // daemon can be queried like the CLI (`cli-box-daemon --version`).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("cli-box-daemon {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!(
            "cli-box-daemon {} — sandbox daemon (managed automatically by cli-box)\n",
            env!("CARGO_PKG_VERSION")
        );
        eprintln!("This binary is normally launched by `cli-box`. Flags:");
        eprintln!("  -V, --version    Print version and exit");
        eprintln!("  -h, --help       Print this help and exit");
        eprintln!("      --headless    Run without Electron (headless / Linux)");
        return;
    }

    tracing_subscriber::fmt::init();

    let headless = args.iter().any(|a| a == "--headless");

    let port = cli_box_core::daemon::find_available_port(15801, 15899)
        .expect("No available port in range 15801-15899");

    tracing::info!("Sandbox daemon started on port {port}");

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    rt.block_on(async move { cli_box_core::daemon::run_daemon(port, headless).await })
        .expect("Daemon exited with error");
}
