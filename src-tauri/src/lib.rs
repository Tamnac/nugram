use std::process::Command;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::io::{Read, BufRead};
use serde::Serialize;
use tauri::ipc::Channel;

/// Windows console handling for our GUI-subsystem app.
///
/// Background: with `windows_subsystem = "windows"`, our process has NO console.
/// When we spawn a console child process, Windows allocates a fresh console
/// window for it, causing a brief terminal flash. The naive fix is to set
/// `CREATE_NO_WINDOW` on every spawn — but that breaks shim wrappers (scoop,
/// winget, etc.) which need a console handle to inherit.
///
/// The robust fix: at startup, allocate a real console for our process and
/// immediately hide it. Child processes then inherit the hidden console — no
/// flashes, no broken shims.
///
/// NOTE on `EnforceRedirectionTrust` (RedirectionGuard): this mitigation blocks
/// traversal of NTFS junctions created by non-admin users (scoop/winget shims).
/// It is *opt-in per-process* (SetProcessMitigationPolicy) and *inherited from
/// the parent process* — it is NOT keyed off the executable subsystem. The only
/// way our app gets it is when launched as a child of a process that has it on,
/// notably `msiexec` (the Windows Installer Service enables it). That's why the
/// installer's post-install auto-launch broke shims while every normal launch
/// (Explorer/Start menu) is fine. The fix lives in the WiX template (we disable
/// auto-launch), not in the subsystem choice.
#[cfg(windows)]
mod win_api {
    unsafe extern "system" {
        fn AllocConsole() -> i32;
        fn GetConsoleWindow() -> *mut std::ffi::c_void;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, n_cmd_show: i32) -> i32;
        fn SetWindowPos(
            hwnd: *mut std::ffi::c_void,
            insert_after: *mut std::ffi::c_void,
            x: i32, y: i32, cx: i32, cy: i32,
            flags: u32,
        ) -> i32;
        fn ShellExecuteW(
            hwnd: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> isize;
    }
    const SW_HIDE: i32 = 0;
    const SW_SHOW: i32 = 5;
    // Move + resize + no-activate + no-zorder, to push the console offscreen
    // before it can paint, minimizing flash on slow systems.
    const SWP_FLAGS: u32 = 0x0010 /*NOACTIVATE*/ | 0x0004 /*NOZORDER*/ | 0x0040 /*SHOWWINDOW=NO when combined with SW_HIDE*/;

    static CONSOLE_ONCE: std::sync::Once = std::sync::Once::new();

    /// Allocate a hidden console exactly once. AllocConsole spawns conhost under
    /// the hood (~150 ms cold), so we defer it to the first shell-tool spawn
    /// instead of paying it on every startup — most launches never run a tool.
    pub fn ensure_console() {
        CONSOLE_ONCE.call_once(|| {
            unsafe {
                if AllocConsole() == 0 { return; }
                let hwnd = GetConsoleWindow();
                if hwnd.is_null() { return; }
                // Push offscreen first (helps reduce flash on some systems), then hide.
                SetWindowPos(hwnd, std::ptr::null_mut(), -32000, -32000, 0, 0, SWP_FLAGS);
                ShowWindow(hwnd, SW_HIDE);
            }
        });
    }

    fn to_wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn shell_open(path: &str) -> Result<(), String> {
        let file = to_wide(path);
        let open = to_wide("open");
        let ret = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(), open.as_ptr(), file.as_ptr(),
                std::ptr::null(), std::ptr::null(), SW_SHOW,
            )
        };
        if ret as usize > 32 { Ok(()) }
        else { Err(format!("ShellExecuteW failed with code {ret}")) }
    }

    /// Retry with `https://` prepended (for bare domains like `hi.com`).
    pub fn shell_open_url_fallback(path: &str) -> Result<(), String> {
        let url = format!("https://{path}");
        shell_open(&url)
    }
}

/// Build a Command. On Windows, we rely on the parent process owning a hidden
/// console (allocated at startup) so children inherit it without flashing.
fn new_command(program: &str) -> Command {
    Command::new(program)
}

/// Terminate a process and all of its descendants. Killing only the direct
/// child (the shell) leaves the actual command and its children running — and
/// holding our stdout/stderr pipes open — so timeouts and cancellation appear
/// to hang forever. We always tear down the whole tree, synchronously.
fn kill_tree(pid: u32) {
    if pid == 0 { return; }
    #[cfg(windows)]
    {
        // Invoked directly (not via a shell), so switches take a single slash.
        let _ = new_command("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // The shell is spawned in its own process group (see process_group below),
        // so a negative pid signals the whole group.
        let _ = new_command("kill")
            .arg("-9")
            .arg(format!("-{}", pid))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[derive(Serialize, Clone)]
struct ShellOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    duration_ms: u64,
}

/// Per-session shell state, so concurrent sessions (e.g. sub-agents) don't
/// clobber each other's `previous` output or cancel each other's commands.
#[derive(Default)]
struct SessionShell {
    last_output: Mutex<Option<ShellOutput>>,
    active_pid: AtomicU32,
    cancelled: AtomicBool,
}

#[derive(Default)]
struct ShellState {
    sessions: Mutex<HashMap<String, Arc<SessionShell>>>,
}

impl ShellState {
    fn session(&self, key: Option<&str>) -> Arc<SessionShell> {
        let key = key.unwrap_or("main");
        let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(map.entry(key.to_string()).or_default())
    }
}

/// Strip ANSI escape sequences (CSI sequences like \x1b[31m, plus single-char escapes)
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                // consume params + terminator letter
                while let Some(&nc) = chars.peek() {
                    chars.next();
                    if nc.is_ascii_alphabetic() { break; }
                }
            } else {
                chars.next(); // single-char escape
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Find the best available shell. Cached after first call.
///
/// Windows strategy:
///   1. NUGRAM_SHELL env override (full path to any shell binary that takes `-c`)
///   2. Try all common bash.exe locations (Git for Windows, scoop user/global)
///   3. Fall back to absolute PowerShell paths (NEVER a PATH lookup — that can
///      hit scoop/winget shims which mis-handle GUI-subsystem parents)
///
/// On first selection we write `%TEMP%\nugram-shell.log` with what was picked
/// and what was probed, so users can diagnose why their preferred shell wasn't
/// chosen.
fn find_shell() -> (&'static str, &'static [&'static str]) {
    static CACHED: OnceLock<(String, Vec<&'static str>)> = OnceLock::new();
    let (bin, args) = CACHED.get_or_init(|| {
        if cfg!(windows) {
            let mut probed: Vec<(String, bool)> = Vec::new();

            // 0. Env override
            if let Ok(custom) = std::env::var("NUGRAM_SHELL") {
                if !custom.trim().is_empty() && std::path::Path::new(&custom).exists() {
                    write_shell_log(&custom, &["-c"], &probed);
                    return (custom, vec!["-c"]);
                }
            }

            // 1. Build bash candidate list — include both `bin\bash.exe` (Git
            //    for Windows launcher) and `usr\bin\bash.exe` (real msys2 bash)
            //    for each install root.
            let mut roots: Vec<String> = vec![
                "C:\\Program Files\\Git".to_string(),
                "C:\\Program Files (x86)\\Git".to_string(),
            ];
            if let Ok(home) = std::env::var("USERPROFILE") {
                roots.push(format!("{}\\scoop\\apps\\git\\current", home));
            }
            if let Ok(scoop) = std::env::var("SCOOP") {
                roots.push(format!("{}\\apps\\git\\current", scoop));
            }
            if let Ok(scoop_global) = std::env::var("SCOOP_GLOBAL") {
                roots.push(format!("{}\\apps\\git\\current", scoop_global));
            }
            roots.push("C:\\ProgramData\\scoop\\apps\\git\\current".to_string());

            let mut bash_candidates: Vec<String> = Vec::new();
            for root in &roots {
                bash_candidates.push(format!("{}\\usr\\bin\\bash.exe", root));
                bash_candidates.push(format!("{}\\bin\\bash.exe", root));
            }
            // Standalone msys2 / WSL bash locations
            bash_candidates.push("C:\\msys64\\usr\\bin\\bash.exe".to_string());
            bash_candidates.push("C:\\Windows\\System32\\bash.exe".to_string()); // WSL

            for path in &bash_candidates {
                let exists = std::path::Path::new(path).exists();
                probed.push((path.clone(), exists));
                if exists {
                    write_shell_log(path, &["-l", "-c"], &probed);
                    return (path.clone(), vec!["-l", "-c"]);
                }
            }

            // 1b. Scoop "current" junctions can be broken (stale install, etc.).
            //     Enumerate every versioned dir under scoop\apps\git\ as a fallback.
            let mut scoop_apps_dirs: Vec<String> = Vec::new();
            if let Ok(home) = std::env::var("USERPROFILE") {
                scoop_apps_dirs.push(format!("{}\\scoop\\apps\\git", home));
            }
            if let Ok(scoop) = std::env::var("SCOOP") {
                scoop_apps_dirs.push(format!("{}\\apps\\git", scoop));
            }
            scoop_apps_dirs.push("C:\\ProgramData\\scoop\\apps\\git".to_string());
            for apps in &scoop_apps_dirs {
                let Ok(entries) = std::fs::read_dir(apps) else { continue };
                for entry in entries.flatten() {
                    let dir = entry.path();
                    if !dir.is_dir() { continue }
                    // Skip the "current" symlink itself (already probed above)
                    if dir.file_name().and_then(|n| n.to_str()) == Some("current") { continue }
                    for sub in ["usr\\bin\\bash.exe", "bin\\bash.exe"] {
                        let cand = dir.join(sub);
                        let s = cand.to_string_lossy().into_owned();
                        let exists = cand.exists();
                        probed.push((s.clone(), exists));
                        if exists {
                            write_shell_log(&s, &["-l", "-c"], &probed);
                            return (s, vec!["-l", "-c"]);
                        }
                    }
                }
            }

            // 1c. Last bash attempt: read scoop's bash.shim file to get target path
            let mut shim_paths: Vec<String> = Vec::new();
            if let Ok(home) = std::env::var("USERPROFILE") {
                shim_paths.push(format!("{}\\scoop\\shims\\bash.shim", home));
            }
            if let Ok(scoop) = std::env::var("SCOOP") {
                shim_paths.push(format!("{}\\shims\\bash.shim", scoop));
            }
            shim_paths.push("C:\\ProgramData\\scoop\\shims\\bash.shim".to_string());
            for shim_path in &shim_paths {
                let Ok(contents) = std::fs::read_to_string(shim_path) else { continue };
                for line in contents.lines() {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.strip_prefix("path") {
                        let val = rest.trim_start_matches(|c: char| c == '=' || c.is_whitespace());
                        let val = val.trim().trim_matches('"');
                        let exists = std::path::Path::new(val).exists();
                        probed.push((format!("(shim→) {}", val), exists));
                        if exists {
                            write_shell_log(val, &["-l", "-c"], &probed);
                            return (val.to_string(), vec!["-l", "-c"]);
                        }
                        break;
                    }
                }
            }

            // 2. PowerShell — use absolute paths so we never hit a shim.
            let ps_candidates = [
                "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
                "C:\\Program Files\\PowerShell\\6\\pwsh.exe",
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            ];
            for path in &ps_candidates {
                let exists = std::path::Path::new(path).exists();
                probed.push((path.to_string(), exists));
                if exists {
                    write_shell_log(path, &["-NoProfile", "-NonInteractive", "-Command"], &probed);
                    return (
                        path.to_string(),
                        vec!["-NoProfile", "-NonInteractive", "-Command"],
                    );
                }
            }

            // Last-resort: PATH lookup (may hit a shim — but we've exhausted options)
            write_shell_log("powershell", &["-NoProfile", "-NonInteractive", "-Command"], &probed);
            ("powershell".to_string(), vec!["-NoProfile", "-NonInteractive", "-Command"])
        } else {
            ("sh".to_string(), vec!["-c"])
        }
    });
    (bin.as_str(), args.as_slice())
}

/// Write a one-time diagnostic log so users can see which shell was chosen
/// and what was probed. Best-effort; failures are ignored.
fn write_shell_log(picked: &str, picked_args: &[&str], probed: &[(String, bool)]) {
    #[cfg(windows)]
    {
        let Ok(temp) = std::env::var("TEMP") else { return };
        let mut s = String::new();
        s.push_str(&format!("Nugram shell selection ({})\n", chrono_now()));
        s.push_str(&format!("Picked: {} {:?}\n\n", picked, picked_args));
        s.push_str("Probed:\n");
        for (p, exists) in probed {
            s.push_str(&format!("  [{}] {}\n", if *exists { "OK" } else { "--" }, p));
        }
        let _ = std::fs::write(format!("{}\\nugram-shell.log", temp), s);
    }
    #[cfg(not(windows))]
    {
        let _ = (picked, picked_args, probed);
    }
}

/// Wall-clock stamp for run separators. `pub` for main.rs.
pub fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("epoch {}s", d.as_secs()))
        .unwrap_or_else(|_| "unknown".to_string())
}

#[tauri::command]
async fn shell(
    command: Option<String>,
    timeout_secs: Option<u64>,
    previous: Option<bool>,
    cwd: Option<String>,
    session: Option<String>,
    on_output: Channel<String>,
    state: tauri::State<'_, ShellState>,
) -> Result<ShellOutput, String> {
    let shell_session = state.session(session.as_deref());

    // If previous=true, return the stored full output
    if previous.unwrap_or(false) {
        let guard = shell_session.last_output.lock().map_err(|e| e.to_string())?;
        return match guard.as_ref() {
            Some(out) => Ok(out.clone()),
            None => Err("No previous shell output stored".to_string()),
        };
    }

    let command = command.ok_or("command is required")?;
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(30));

    // Ensure the hidden console exists so child processes (and shim wrappers)
    // inherit a console handle without flashing. Allocated lazily — first spawn.
    #[cfg(windows)]
    win_api::ensure_console();

    let (shell_bin, shell_args) = find_shell();

    let mut cmd = new_command(shell_bin);
    for arg in shell_args {
        cmd.arg(arg);
    }
    cmd.arg(&command);

    if let Some(dir) = &cwd {
        cmd.current_dir(dir);
    }

    // Put the shell in its own process group so kill_tree can signal the whole
    // group (the shell plus everything it spawns) at once on timeout/cancel.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .stdin(std::process::Stdio::null())  // no stdin — prevents hangs on interactive commands
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn shell ({}): {}", shell_bin, e))?;

    // Store PID for cancellation, reset cancelled flag
    shell_session.active_pid.store(child.id(), Ordering::SeqCst);
    shell_session.cancelled.store(false, Ordering::SeqCst);

    // Drain stdout and stderr concurrently into shared buffers. Using shared
    // buffers (rather than the threads' return values) lets us recover partial
    // output without join()-ing — a killed process can leave a detached child
    // holding a pipe open, which would block join() indefinitely.
    let stdout_pipe = child.stdout.take().unwrap();
    let stderr_pipe = child.stderr.take().unwrap();
    let pid = child.id();

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    // Stream stdout line-by-line via channel for live UI updates
    let so_buf = Arc::clone(&stdout_buf);
    let stdout_thread = std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout_pipe);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let clean = strip_ansi(&line);
            let _ = on_output.send(clean.clone());
            if let Ok(mut b) = so_buf.lock() {
                b.push_str(&clean);
                b.push('\n');
            }
        }
    });
    let se_buf = Arc::clone(&stderr_buf);
    let stderr_thread = std::thread::spawn(move || {
        let mut raw = String::new();
        std::io::BufReader::new(stderr_pipe).read_to_string(&mut raw).ok();
        if let Ok(mut b) = se_buf.lock() {
            *b = strip_ansi(&raw);
        }
    });

    // Poll for process exit with timeout + cancellation. On kill we tear down
    // the whole process tree — killing only the shell leaves its children alive
    // (and holding the output pipes open), which is why timeouts and cancels
    // often appeared to do nothing.
    let start = std::time::Instant::now();
    let mut timed_out = false;
    let mut was_cancelled = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if shell_session.cancelled.load(Ordering::SeqCst) {
                    kill_tree(pid);
                    was_cancelled = true;
                    break;
                }
                if start.elapsed() > timeout {
                    kill_tree(pid);
                    timed_out = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }

    shell_session.active_pid.store(0, Ordering::SeqCst);
    let duration_ms = start.elapsed().as_millis() as u64;

    // Reap the shell (kill_tree already terminated the tree synchronously).
    let exit_code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);

    // Let the reader threads flush now that the pipes are closing, but never
    // block forever on a detached grandchild that kept a pipe open — read
    // whatever was captured so far instead.
    let join_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while (!stdout_thread.is_finished() || !stderr_thread.is_finished())
        && std::time::Instant::now() < join_deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let stdout_clean = stdout_buf.lock().map(|b| b.clone()).unwrap_or_default();
    let mut stderr_clean = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

    if timed_out {
        let prefix = format!("Command timed out after {}s\n", timeout.as_secs());
        stderr_clean = prefix + &stderr_clean;
    } else if was_cancelled {
        stderr_clean = "Command cancelled\n".to_string() + &stderr_clean;
    }

    let output = ShellOutput {
        stdout: stdout_clean,
        stderr: stderr_clean,
        exit_code,
        duration_ms,
    };

    if let Ok(mut guard) = shell_session.last_output.lock() {
        *guard = Some(output.clone());
    }

    Ok(output)
}

#[tauri::command]
async fn cancel_shell(session: Option<String>, state: tauri::State<'_, ShellState>) -> Result<(), String> {
    let shell_session = state.session(session.as_deref());
    shell_session.cancelled.store(true, Ordering::SeqCst);
    // Kill immediately too. The poll loop would also catch the flag within
    // ~50ms, but a direct tree-kill makes cancellation feel instant.
    kill_tree(shell_session.active_pid.load(Ordering::SeqCst));
    Ok(())
}

/// Return the resolved shell binary path so the frontend can show which shell
/// is in use (and adjust tool descriptions accordingly).
#[tauri::command]
fn get_shell_info() -> String {
    let (bin, _) = find_shell();
    bin.to_string()
}

#[tauri::command]
fn open_external(path: String, cwd: Option<String>) -> Result<(), String> {
    // Leave URLs untouched; only filesystem paths get resolved against cwd.
    let is_url = path.contains("://");
    let resolved = if !is_url && std::path::Path::new(&path).is_relative() {
        match &cwd {
            Some(dir) => std::path::Path::new(dir).join(&path).to_string_lossy().into_owned(),
            None => path.clone(),
        }
    } else {
        path.clone()
    };
    #[cfg(windows)]
    {
        // ShellExecuteW does not accept forward slashes in file paths (unlike
        // most Win32 APIs), so a link into a subfolder like `src/render.rs`
        // fails with ERROR_FILE_NOT_FOUND. URLs must keep their slashes.
        let resolved_win = if is_url { resolved } else { resolved.replace('/', "\\") };
        return win_api::shell_open(&resolved_win).or_else(|e| {
            // If it failed and wasn't already a URL, retry as https://
            // (handles bare domains like "hi.com" that markdown doesn't auto-scheme)
            if !is_url { win_api::shell_open_url_fallback(&path) } else { Err(e) }
        });
    }
    #[cfg(target_os = "macos")]
    { new_command("open").arg(&resolved).spawn().map_err(|e| e.to_string())?; }
    #[cfg(not(any(windows, target_os = "macos")))]
    { new_command("xdg-open").arg(&resolved).spawn().map_err(|e| e.to_string())?; }
    #[cfg(not(windows))]
    Ok(())
}

/// Folder passed on the command line at launch, resolved once at startup.
///
/// Accepts a positional path argument, or `.`/`--cwd` to use the launching
/// terminal's working directory. Returns the canonical absolute path if it
/// names an existing directory, else `None`. Launches from Explorer/Start menu
/// pass no arg (and their cwd is junk like system32), so we deliberately
/// require an explicit arg rather than defaulting to cwd.
static LAUNCH_FOLDER: OnceLock<Option<String>> = OnceLock::new();

fn resolve_launch_folder() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| a != "--");
    let raw = match arg.as_deref() {
        None => return None,
        Some(".") | Some("--cwd") => std::env::current_dir().ok()?,
        Some(p) if p.starts_with("--") => return None,
        Some(p) => std::path::PathBuf::from(p),
    };
    let abs = std::fs::canonicalize(&raw).ok()?;
    if !abs.is_dir() {
        return None;
    }
    // Strip the Windows \\?\ verbatim prefix that canonicalize adds.
    let s = abs.to_string_lossy();
    Some(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or_else(|| s.into_owned()))
}

#[tauri::command]
fn get_launch_folder() -> Option<String> {
    LAUNCH_FOLDER.get().cloned().flatten()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Note: the hidden console (so child processes inherit a console handle
    // without flashing) is allocated lazily on the first shell spawn — see
    // win_api::ensure_console. AllocConsole costs ~150 ms, and most launches
    // never run a shell tool.
    use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

    LAUNCH_FOLDER.set(resolve_launch_folder()).ok();

    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: r#"
                CREATE TABLE IF NOT EXISTS chats (
                    id               TEXT PRIMARY KEY,
                    name             TEXT NOT NULL DEFAULT 'New Chat',
                    parent_id        TEXT REFERENCES chats(id) ON DELETE SET NULL,
                    fork_message_id  INTEGER,
                    created          INTEGER NOT NULL,
                    updated          INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id                INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                    idx               INTEGER NOT NULL,
                    role              TEXT NOT NULL,
                    content           TEXT NOT NULL,
                    current_version   INTEGER NOT NULL DEFAULT 0,
                    thinking          TEXT,
                    thinking_signature TEXT,
                    tool_calls        TEXT,
                    tool_results      TEXT,
                    tool_call_id      TEXT,
                    ids               TEXT,
                    name              TEXT,
                    models            TEXT,
                    usage             TEXT,
                    timing            TEXT,
                    UNIQUE (chat_id, idx)
                );

                CREATE TABLE IF NOT EXISTS config (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_chat_metadata_columns",
            sql: r#"
                ALTER TABLE chats ADD COLUMN config_name TEXT;
                ALTER TABLE chats ADD COLUMN meta TEXT;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_chat_version_column",
            sql: r#"
                ALTER TABLE chats ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_message_images_and_attachments",
            sql: r#"
                ALTER TABLE messages ADD COLUMN images TEXT;

                CREATE TABLE IF NOT EXISTS attachments (
                    id      TEXT PRIMARY KEY,
                    mime    TEXT NOT NULL,
                    data    TEXT NOT NULL,
                    created INTEGER NOT NULL
                );
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_message_providers",
            sql: r#"
                ALTER TABLE messages ADD COLUMN providers TEXT;
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add_sessions_and_chats_updated_index",
            sql: r#"
                CREATE TABLE IF NOT EXISTS sessions (
                    id    TEXT PRIMARY KEY,
                    seen  INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated);
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add_message_files",
            sql: r#"
                ALTER TABLE messages ADD COLUMN files TEXT;
            "#,
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:story.db", migrations)
                .build(),
        )
        .manage(ShellState::default())
        .invoke_handler(tauri::generate_handler![shell, cancel_shell, open_external, get_shell_info, get_launch_folder]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
