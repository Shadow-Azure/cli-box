use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
use {
    nix::sys::signal::{kill, Signal},
    nix::unistd::Pid,
    portable_pty::{native_pty_system, CommandBuilder, PtySize},
};

/// Process information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
    pub is_running: bool,
}

/// PTY session holding the reader/writer handles for I/O
#[cfg(target_os = "macos")]
struct PtySession {
    reader: Box<dyn std::io::Read + Send>,
    writer: Box<dyn std::io::Write + Send>,
    #[allow(dead_code)]
    child_pid: u32,
    command: String,
}

/// Track active PTY sessions by sandbox-tracked PID
static SESSIONS: std::sync::LazyLock<Mutex<HashMap<u32, PtySession>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Counter for generating unique tracked PIDs
static NEXT_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1000);

/// Process manager for launching and managing apps/CLIs in the sandbox
pub struct ProcessManager;

impl ProcessManager {
    /// Launch a macOS .app by path using the `open` command.
    /// This avoids ObjC NSExceptions that crash the Rust process.
    /// Returns (ProcessInfo, Option<SCWindow ID>) — the window is discovered by
    /// searching for a title containing the app's stem name after a short delay.
    #[cfg(target_os = "macos")]
    pub fn spawn_app(app_path: &str) -> Result<ProcessInfo> {
        let (info, _window_id) = Self::spawn_app_with_window(app_path)?;
        Ok(info)
    }

    /// Launch a macOS .app and discover its SCWindow ID.
    /// Returns both the process info and the discovered window ID (if found).
    #[cfg(target_os = "macos")]
    pub fn spawn_app_with_window(app_path: &str) -> Result<(ProcessInfo, Option<u32>)> {
        let path = std::path::Path::new(app_path);
        if !path.exists() {
            return Err(AppError::Process(format!(
                "App path does not exist: {app_path}"
            )));
        }

        let app_name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let output = std::process::Command::new("open")
            .arg(app_path)
            .output()
            .map_err(|e| AppError::Process(format!("Failed to run `open` command: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Process(format!(
                "Failed to launch app: {app_path} ({stderr})"
            )));
        }

        let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let info = ProcessInfo {
            pid: id,
            name: app_name.clone(),
            path: Some(app_path.to_string()),
            is_running: true,
        };

        // Wait for the app window to appear, then discover its SCWindow ID
        std::thread::sleep(std::time::Duration::from_millis(800));
        let window_id = crate::capture::ScreenCapture::find_window_by_title(&app_name).ok();

        tracing::info!(
            "Launched app: {} (tracked_id={}, window_id={:?})",
            app_path,
            id,
            window_id
        );

        Ok((info, window_id))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn spawn_app(app_path: &str) -> Result<ProcessInfo> {
        let _ = app_path;
        Err(AppError::Process(
            "spawn_app only supported on macOS".into(),
        ))
    }

    /// Launch a CLI process with PTY support
    #[cfg(target_os = "macos")]
    pub fn spawn_cli(command: &str, args: &[String]) -> Result<ProcessInfo> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Process(format!("Failed to open PTY: {e}")))?;

        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Process(format!("Failed to spawn command: {e}")))?;

        let child_pid = child.process_id();
        // Drop slave - the child process owns it now
        drop(pty_pair.slave);

        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Process(format!("Failed to clone PTY reader: {e}")))?;
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| AppError::Process(format!("Failed to take PTY writer: {e}")))?;

        let tracked_id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        let mut sessions = SESSIONS
            .lock()
            .map_err(|e| AppError::Process(e.to_string()))?;
        sessions.insert(
            tracked_id,
            PtySession {
                reader,
                writer,
                child_pid: child_pid.unwrap_or(0),
                command: command.to_string(),
            },
        );

        tracing::info!(
            "Spawned CLI: {} (tracked_id={}, os_pid={:?})",
            command,
            tracked_id,
            child_pid
        );

        Ok(ProcessInfo {
            pid: tracked_id,
            name: command.to_string(),
            path: None,
            is_running: true,
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn spawn_cli(_command: &str, _args: &[String]) -> Result<ProcessInfo> {
        Err(AppError::Process(
            "spawn_cli only supported on macOS".into(),
        ))
    }

    /// List all running processes in the sandbox
    pub fn list_processes() -> Result<Vec<ProcessInfo>> {
        let sessions = SESSIONS
            .lock()
            .map_err(|e| AppError::Process(e.to_string()))?;
        let processes: Vec<ProcessInfo> = sessions
            .iter()
            .map(|(id, s)| ProcessInfo {
                pid: *id,
                name: s.command.clone(),
                path: None,
                is_running: true,
            })
            .collect();
        Ok(processes)
    }

    /// Kill a process by tracked PID
    #[cfg(target_os = "macos")]
    pub fn kill_process(pid: u32) -> Result<()> {
        let mut sessions = SESSIONS
            .lock()
            .map_err(|e| AppError::Process(e.to_string()))?;

        if let Some(session) = sessions.remove(&pid) {
            // Kill the actual OS child process
            let os_pid = session.child_pid;
            if os_pid > 0 {
                kill(Pid::from_raw(os_pid as i32), Signal::SIGTERM).map_err(|e| {
                    AppError::Process(format!("Failed to kill process {os_pid}: {e}"))
                })?;
            }
            // Dropping the master closes the PTY
            drop(session);
            tracing::info!("Killed process: tracked_id={}, os_pid={}", pid, os_pid);
        } else {
            return Err(AppError::Process(format!(
                "Process {pid} not found in sandbox"
            )));
        }

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn kill_process(pid: u32) -> Result<()> {
        let _ = pid;
        Err(AppError::Process(
            "kill_process only supported on macOS".into(),
        ))
    }

    /// Send input to a PTY process
    #[cfg(target_os = "macos")]
    pub fn send_input(pid: u32, data: &[u8]) -> Result<()> {
        let mut sessions = SESSIONS
            .lock()
            .map_err(|e| AppError::Process(e.to_string()))?;
        if let Some(session) = sessions.get_mut(&pid) {
            session
                .writer
                .write_all(data)
                .map_err(|e| AppError::Process(format!("Failed to write to PTY: {e}")))?;
            session
                .writer
                .flush()
                .map_err(|e| AppError::Process(format!("Failed to flush PTY: {e}")))?;
            Ok(())
        } else {
            Err(AppError::Process(format!("Process {pid} not found")))
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn send_input(_pid: u32, _data: &[u8]) -> Result<()> {
        Err(AppError::Process(
            "send_input only supported on macOS".into(),
        ))
    }

    /// Read output from a PTY process (non-blocking)
    #[cfg(target_os = "macos")]
    pub fn read_output(pid: u32) -> Result<Option<String>> {
        use std::io::Read;
        let mut sessions = SESSIONS
            .lock()
            .map_err(|e| AppError::Process(e.to_string()))?;
        if let Some(session) = sessions.get_mut(&pid) {
            let mut buf = [0u8; 4096];
            match session.reader.read(&mut buf) {
                Ok(0) => Ok(None),
                Ok(n) => Ok(Some(String::from_utf8_lossy(&buf[..n]).to_string())),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
                Err(e) => Err(AppError::Process(format!("Failed to read PTY: {e}"))),
            }
        } else {
            Err(AppError::Process(format!("Process {pid} not found")))
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn read_output(_pid: u32) -> Result<Option<String>> {
        Err(AppError::Process(
            "read_output only supported on macOS".into(),
        ))
    }
}
