//! SSH execution backend: a russh client pool + SFTP file ops, exposed as
//! Tauri commands for `src/helpers/backend/ssh.ts`. Mirrors the local `shell`
//! command's session-keyed cancellation and previous-output behavior. Only the
//! wire protocol lives here — ~/.ssh/config parsing and alias resolution are
//! TS-side in `src/helpers/backend/sshConfig.ts`.
//!
//! Known limits: host keys are accepted without verification (no TOFU pinning),
//! POSIX remotes only, and cancelling a command closes the channel — the remote
//! process keeps running, since exec channels carry no signals without a PTY.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::ChannelMsg;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{strip_ansi, RunningCommands, ShellOutput};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
	/// Stable id from the frontend; keys the connection pool.
	pub id: String,
	/// Real hostname, already resolved TS-side (sshConfig.ts).
	pub host: String,
	#[serde(default = "default_port")]
	pub port: u16,
	/// Falls back to USER/USERNAME env vars, then "root".
	#[serde(default)]
	pub user: Option<String>,
	/// Explicit private key path; beats the ~/.ssh/id_* defaults below.
	#[serde(default)]
	pub key_path: Option<String>,
	#[serde(default)]
	pub key_passphrase: Option<String>,
	#[serde(default)]
	pub password: Option<String>,
}

fn default_port() -> u16 {
	22
}

fn user_home() -> Option<PathBuf> {
	std::env::var_os("HOME")
		.or_else(|| std::env::var_os("USERPROFILE"))
		.map(PathBuf::from)
}

struct Client;

impl client::Handler for Client {
	type Error = russh::Error;

	async fn check_server_key(&mut self, _key: &PublicKey) -> Result<bool, Self::Error> {
		Ok(true)
	}
}

async fn connect(cfg: &SshConfig) -> Result<Handle<Client>, String> {
	let user = cfg
		.user
		.clone()
		.or_else(|| {
			std::env::var("USER")
				.or_else(|_| std::env::var("USERNAME"))
				.ok()
		})
		.unwrap_or_else(|| "root".into());
	let config = Arc::new(client::Config::default());
	let mut session = client::connect(config, (cfg.host.clone(), cfg.port), Client)
		.await
		.map_err(|e| format!("connect {}:{}: {e}", cfg.host, cfg.port))?;

	// Key auth: explicit key first, then ~/.ssh defaults, then password.
	let mut key_paths: Vec<PathBuf> = cfg.key_path.iter().map(PathBuf::from).collect();
	if let Some(home) = user_home() {
		for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
			let p = home.join(".ssh").join(name);
			if p.exists() && !key_paths.contains(&p) {
				key_paths.push(p);
			}
		}
	}
	let mut tried: Vec<String> = Vec::new();
	for path in &key_paths {
		let key = match load_secret_key(path, cfg.key_passphrase.as_deref()) {
			Ok(k) => k,
			Err(e) => {
				tried.push(format!("{}: {e}", path.display()));
				continue;
			}
		};
		let hash_alg = session
			.best_supported_rsa_hash()
			.await
			.map_err(|e| e.to_string())?
			.flatten();
		match session
			.authenticate_publickey(
				user.clone(),
				PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
			)
			.await
		{
			Ok(res) if res.success() => return Ok(session),
			Ok(_) => tried.push(format!("{}: rejected", path.display())),
			Err(e) => tried.push(format!("{}: {e}", path.display())),
		}
	}
	if let Some(password) = cfg.password.as_deref().filter(|p| !p.is_empty()) {
		match session.authenticate_password(user.clone(), password).await {
			Ok(res) if res.success() => return Ok(session),
			Ok(_) => tried.push("password: rejected".into()),
			Err(e) => tried.push(format!("password: {e}")),
		}
	}
	let _ = session
		.disconnect(russh::Disconnect::ByApplication, "", "en")
		.await;
	if tried.is_empty() {
		Err(format!(
            "authentication failed for {}@{}: no keys found (~/.ssh/id_*) and no password configured",
            user, cfg.host
        ))
	} else {
		Err(format!(
			"authentication failed for {}@{}: {}",
			user,
			cfg.host,
			tried.join("; ")
		))
	}
}

/// Per-session exec state, mirroring SessionShell for the local shell: previous
/// output (`previous: true`) and the running commands' cancel flags.
#[derive(Default)]
struct ExecSession {
	last_output: Mutex<Option<ShellOutput>>,
	running: RunningCommands,
}

pub struct SshConn {
	session: tokio::sync::Mutex<Handle<Client>>,
	sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
	execs: Mutex<HashMap<String, Arc<ExecSession>>>,
}

impl SshConn {
	fn exec_session(&self, key: Option<&str>) -> Arc<ExecSession> {
		let key = key.unwrap_or("main");
		let mut map = self.execs.lock().unwrap_or_else(|e| e.into_inner());
		Arc::clone(map.entry(key.to_string()).or_default())
	}

	async fn sftp(&self) -> Result<Arc<SftpSession>, OpError> {
		let mut guard = self.sftp.lock().await;
		if let Some(s) = guard.as_ref() {
			return Ok(Arc::clone(s));
		}
		let channel = self
			.session
			.lock()
			.await
			.channel_open_session()
			.await
			.map_err(fatal)?;
		channel
			.request_subsystem(true, "sftp")
			.await
			.map_err(fatal)?;
		let s = Arc::new(
			SftpSession::new(channel.into_stream())
				.await
				.map_err(fatal)?,
		);
		*guard = Some(Arc::clone(&s));
		Ok(s)
	}
}

#[derive(Default)]
pub struct SshState {
	conns: tokio::sync::Mutex<HashMap<String, Arc<SshConn>>>,
}

impl SshState {
	async fn conn(&self, cfg: &SshConfig) -> Result<Arc<SshConn>, String> {
		let mut map = self.conns.lock().await;
		if let Some(c) = map.get(&cfg.id) {
			return Ok(Arc::clone(c));
		}
		let session = connect(cfg).await?;
		let conn = Arc::new(SshConn {
			session: tokio::sync::Mutex::new(session),
			sftp: tokio::sync::Mutex::new(None),
			execs: Mutex::new(HashMap::new()),
		});
		map.insert(cfg.id.clone(), Arc::clone(&conn));
		Ok(conn)
	}

	async fn evict(&self, id: &str) {
		if let Some(conn) = self.conns.lock().await.remove(id) {
			let _ = conn
				.session
				.lock()
				.await
				.disconnect(russh::Disconnect::ByApplication, "", "en")
				.await;
		}
	}
}

/// A failed op's verdict on the pooled connection. `Served` errors were answered
/// by the server (missing path, permission denied) — the connection is healthy
/// and concurrent ops must not be disturbed; `stat` absence probes rely on this.
/// `Fatal` (protocol/transport) evicts it so the next command reconnects.
enum OpError {
	Served(String),
	Fatal(String),
}

fn served(e: impl std::fmt::Display) -> OpError {
	OpError::Served(e.to_string())
}

fn fatal(e: impl std::fmt::Display) -> OpError {
	OpError::Fatal(e.to_string())
}

/// SFTP errors: a Status reply (or the openssh limits extension) means the
/// server answered; anything else is protocol/transport failure.
fn sftp_err(e: SftpError, context: &str) -> OpError {
	let msg = if context.is_empty() {
		e.to_string()
	} else {
		format!("{context}: {e}")
	};
	match e {
		SftpError::Status(_) | SftpError::Limited(_) => OpError::Served(msg),
		_ => OpError::Fatal(msg),
	}
}

/// Run `op` against the pooled connection. Fatal failures evict it, so the next
/// command reconnects (auto-reconnect semantics — no UI state to manage).
async fn with_conn<T, F, Fut>(state: &SshState, cfg: &SshConfig, op: F) -> Result<T, String>
where
	F: FnOnce(Arc<SshConn>) -> Fut,
	Fut: std::future::Future<Output = Result<T, OpError>>,
{
	let conn = state.conn(cfg).await?;
	match op(conn).await {
		Ok(v) => Ok(v),
		Err(OpError::Served(e)) => Err(e),
		Err(OpError::Fatal(e)) => {
			state.evict(&cfg.id).await;
			Err(e)
		}
	}
}

/// Single-quote a POSIX shell argument.
fn sh_quote(s: &str) -> String {
	format!("'{}'", s.replace('\'', "'\\''"))
}

#[tauri::command]
pub async fn ssh_exec(
	config: SshConfig,
	command: Option<String>,
	timeout_secs: Option<u64>,
	previous: Option<bool>,
	cwd: Option<String>,
	session: Option<String>,
	id: Option<String>,
	on_output: Channel<String>,
	state: tauri::State<'_, SshState>,
) -> Result<ShellOutput, String> {
	with_conn(&state, &config, |conn| async move {
		let es = conn.exec_session(session.as_deref());

		if previous.unwrap_or(false) {
			let guard = es.last_output.lock().map_err(served)?;
			return match guard.as_ref() {
				Some(out) => Ok(out.clone()),
				None => Err(served("No previous shell output stored")),
			};
		}

		let command = command.ok_or_else(|| served("command is required"))?;
		let timeout = Duration::from_secs(timeout_secs.unwrap_or(30));
		let full = match &cwd {
			Some(dir) => format!("cd {} && {command}", sh_quote(dir)),
			None => command,
		};

		let mut channel = conn
			.session
			.lock()
			.await
			.channel_open_session()
			.await
			.map_err(fatal)?;
		channel.exec(true, full).await.map_err(fatal)?;
		let running = es.running.register(id, 0);

		let start = Instant::now();
		let mut code: i32 = -1;
		let mut stdout = String::new();
		let mut stderr = String::new();
		// Partial-line buffer: the output channel only carries whole lines,
		// matching the local shell's line stream.
		let mut line = String::new();
		let mut timed_out = false;
		let mut cancelled = false;

		loop {
			if running.cmd.cancelled.load(Ordering::SeqCst) {
				cancelled = true;
				let _ = channel.close().await;
				break;
			}
			if start.elapsed() > timeout {
				timed_out = true;
				let _ = channel.close().await;
				break;
			}
			match tokio::time::timeout(Duration::from_millis(50), channel.wait()).await {
				Err(_) => continue, // poll the cancel/timeout flags
				Ok(None) => break,  // channel closed: command finished
				Ok(Some(msg)) => match msg {
					ChannelMsg::Data { data } => {
						line.push_str(&String::from_utf8_lossy(&data));
						while let Some(nl) = line.find('\n') {
							let l = strip_ansi(line[..nl].trim_end_matches('\r'));
							let _ = on_output.send(l.clone());
							stdout.push_str(&l);
							stdout.push('\n');
							line = line[nl + 1..].to_string();
						}
					}
					ChannelMsg::ExtendedData { data, ext } => {
						if ext == 1 {
							stderr.push_str(&String::from_utf8_lossy(&data));
						}
					}
					ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
					_ => {}
				},
			}
		}
		drop(running);
		// Flush a trailing partial line the way BufRead::lines does at EOF.
		if !line.is_empty() {
			let l = strip_ansi(line.trim_end_matches('\r'));
			let _ = on_output.send(l.clone());
			stdout.push_str(&l);
			stdout.push('\n');
		}

		let mut stderr_clean = strip_ansi(&stderr);
		if timed_out {
			stderr_clean = format!(
				"Command timed out after {}s\n{stderr_clean}",
				timeout.as_secs()
			);
		} else if cancelled {
			stderr_clean = format!("Command cancelled\n{stderr_clean}");
		}

		let output = ShellOutput {
			stdout,
			stderr: stderr_clean,
			exit_code: if cancelled || timed_out { -1 } else { code },
			duration_ms: start.elapsed().as_millis() as u64,
		};
		if let Ok(mut guard) = es.last_output.lock() {
			*guard = Some(output.clone());
		}
		Ok(output)
	})
	.await
}

#[tauri::command]
pub async fn ssh_cancel(
	backend: String,
	session: Option<String>,
	id: Option<String>,
	state: tauri::State<'_, SshState>,
) -> Result<(), String> {
	let conn = state.conns.lock().await.get(&backend).cloned();
	if let Some(conn) = conn {
		conn.exec_session(session.as_deref()).running.cancel(id.as_deref());
	}
	Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStat {
	is_directory: bool,
}

#[tauri::command]
pub async fn ssh_stat(
	config: SshConfig,
	path: String,
	state: tauri::State<'_, SshState>,
) -> Result<SshStat, String> {
	with_conn(&state, &config, |conn| async move {
		let sftp = conn.sftp().await?;
		let meta = sftp.metadata(&path).await.map_err(|e| sftp_err(e, ""))?;
		Ok(SshStat {
			is_directory: meta.is_dir(),
		})
	})
	.await
}

#[tauri::command]
pub async fn ssh_read(
	config: SshConfig,
	path: String,
	state: tauri::State<'_, SshState>,
) -> Result<tauri::ipc::Response, String> {
	let bytes = with_conn(&state, &config, |conn| async move {
		let sftp = conn.sftp().await?;
		let mut file = sftp.open(&path).await.map_err(|e| sftp_err(e, ""))?;
		let mut buf = Vec::new();
		file.read_to_end(&mut buf)
			.await
			.map_err(fatal)?;
		Ok(buf)
	})
	.await?;
	Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn ssh_write(
	config: SshConfig,
	path: String,
	content: String,
	state: tauri::State<'_, SshState>,
) -> Result<(), String> {
	with_conn(&state, &config, |conn| async move {
		let sftp = conn.sftp().await?;
		let mut file = sftp
			.open_with_flags(
				&path,
				OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
			)
			.await
			.map_err(|e| sftp_err(e, ""))?;
		file.write_all(content.as_bytes())
			.await
			.map_err(fatal)?;
		file.shutdown().await.map_err(fatal)?;
		Ok(())
	})
	.await
}

#[tauri::command]
pub async fn ssh_mkdir(
	config: SshConfig,
	path: String,
	state: tauri::State<'_, SshState>,
) -> Result<(), String> {
	with_conn(&state, &config, |conn| async move {
		let sftp = conn.sftp().await?;
		// create_dir isn't recursive: walk components ignoring already-exists
		// failures, then verify the tail is a directory.
		let mut cur = String::new();
		for part in path.split('/').filter(|p| !p.is_empty()) {
			cur.push('/');
			cur.push_str(part);
			let _ = sftp.create_dir(&cur).await;
		}
		let meta = sftp
			.metadata(&path)
			.await
			.map_err(|e| sftp_err(e, &format!("mkdir {path}")))?;
		if meta.is_dir() {
			Ok(())
		} else {
			Err(served(format!("mkdir {path}: exists and is not a directory")))
		}
	})
	.await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirEntry {
	name: String,
	is_directory: bool,
}

#[tauri::command]
pub async fn ssh_read_dir(
	config: SshConfig,
	path: String,
	state: tauri::State<'_, SshState>,
) -> Result<Vec<SshDirEntry>, String> {
	with_conn(&state, &config, |conn| async move {
		let sftp = conn.sftp().await?;
		let entries = sftp
			.read_dir(&path)
			.await
			.map_err(|e| sftp_err(e, ""))?;
		Ok(entries
			.into_iter()
			.map(|e| SshDirEntry {
				name: e.file_name(),
				is_directory: e.metadata().is_dir(),
			})
			.collect())
	})
	.await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbe {
	home: String,
	shell_kind: String,
}

/// Home dir + login shell, so the frontend's Backend can answer `homeDir()` and
/// name the shell in the shell tool's description. Called once per backend.
#[tauri::command]
pub async fn ssh_probe(
	config: SshConfig,
	state: tauri::State<'_, SshState>,
) -> Result<SshProbe, String> {
	with_conn(&state, &config, |conn| async move {
		let sftp = conn.sftp().await?;
		let home = sftp.canonicalize(".").await.map_err(|e| sftp_err(e, ""))?;
		let mut channel = conn
			.session
			.lock()
			.await
			.channel_open_session()
			.await
			.map_err(fatal)?;
		channel
			.exec(true, "printf '%s' \"$SHELL\"")
			.await
			.map_err(fatal)?;
		let mut shell = String::new();
		while let Some(msg) = channel.wait().await {
			if let ChannelMsg::Data { data } = msg {
				shell.push_str(&String::from_utf8_lossy(&data));
			}
		}
		let shell = shell.trim();
		let shell_kind = if shell.contains("bash") {
			"bash".to_string()
		} else if shell.is_empty() {
			"remote shell".to_string()
		} else {
			shell.to_string()
		};
		Ok(SshProbe {
			home: home.trim_end_matches('/').to_string(),
			shell_kind,
		})
	})
	.await
}

#[tauri::command]
pub async fn ssh_disconnect(
	backend: String,
	state: tauri::State<'_, SshState>,
) -> Result<(), String> {
	state.evict(&backend).await;
	Ok(())
}
