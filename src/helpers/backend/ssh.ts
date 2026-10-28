/** An SSH host, via the russh pool in Rust (`src-tauri/src/ssh.rs`). */
import type { Backend, DirEntry, ExecOptions, ExecResult } from './index';
import type { SshBackendConfig } from '../types';
import { resolveSshBackend, type ResolvedSshConfig } from './sshConfig';

let _core: Promise<typeof import('@tauri-apps/api/core')> | null = null;
const core = () => (_core ??= import('@tauri-apps/api/core'));

const decoder = new TextDecoder();

/** Cached alias resolution per backend id (see sshConfig.ts); failures uncache
 *  so the next call retries. evictSshBackend clears both caches. */
const resolvedConfigs = new Map<string, Promise<ResolvedSshConfig>>();
function resolvedFor(config: SshBackendConfig): Promise<ResolvedSshConfig> {
	let p = resolvedConfigs.get(config.id);
	if (!p) {
		p = resolveSshBackend(config);
		p.catch(() => { if (resolvedConfigs.get(config.id) === p) resolvedConfigs.delete(config.id); });
		resolvedConfigs.set(config.id, p);
	}
	return p;
}

interface Probe { home: string; shellKind: string }

/** One probe per backend id; failures uncache so the next call retries after reconnect. */
const probes = new Map<string, Promise<Probe>>();
function probe(config: SshBackendConfig): Promise<Probe> {
	let p = probes.get(config.id);
	if (!p) {
		p = resolvedFor(config).then(async rc => (await core()).invoke<Probe>('ssh_probe', { config: rc }));
		p.catch(() => { if (probes.get(config.id) === p) probes.delete(config.id); });
		probes.set(config.id, p);
	}
	return p;
}

/** Forget a backend: caches here, pooled connection in Rust. Called when a
 *  connection's config changes or is removed, so the next use reconnects. */
export function evictSshBackend(id: string) {
	probes.delete(id);
	resolvedConfigs.delete(id);
	void core().then(({ invoke }) => invoke('ssh_disconnect', { backend: id })).catch(() => {});
}

export function createSshBackend(config: SshBackendConfig): Backend {
	const backend: Backend = {
		id: config.id,
		label: config.label || config.host,
		// POSIX remotes only for now (src-tauri/src/ssh.rs).
		paths: { sep: '/', windows: false },
		shellKind: 'remote shell',

		async exec(opts: ExecOptions): Promise<ExecResult> {
			const [{ invoke, Channel }, rc] = await Promise.all([core(), resolvedFor(config)]);
			// The command always expects a channel, whether or not anyone listens.
			const onOutput = new Channel<string>();
			if (opts.onOutput) onOutput.onmessage = opts.onOutput;
			return invoke<ExecResult>('ssh_exec', {
				config: rc,
				command: opts.command || undefined,
				timeoutSecs: opts.timeoutSecs || undefined,
				previous: opts.previous || undefined,
				cwd: opts.cwd || undefined,
				session: opts.session || undefined,
				id: opts.id,
				onOutput,
			});
		},

		async cancelExec(session, id) {
			const { invoke } = await core();
			await invoke('ssh_cancel', { backend: config.id, session, id });
		},

		async stat(path: string) {
			const { invoke } = await core();
			return invoke<{ isDirectory: boolean }>('ssh_stat', { config: await resolvedFor(config), path });
		},

		async readText(path: string) {
			return decoder.decode(await backend.readBinary(path));
		},

		async readBinary(path: string) {
			const { invoke } = await core();
			const buf = await invoke<ArrayBuffer>('ssh_read', { config: await resolvedFor(config), path });
			return new Uint8Array(buf);
		},

		async writeText(path: string, content: string) {
			const { invoke } = await core();
			await invoke('ssh_write', { config: await resolvedFor(config), path, content });
		},

		async mkdir(path: string) {
			const { invoke } = await core();
			await invoke('ssh_mkdir', { config: await resolvedFor(config), path });
		},

		async readDir(path: string): Promise<DirEntry[]> {
			const { invoke } = await core();
			return invoke<DirEntry[]>('ssh_read_dir', { config: await resolvedFor(config), path });
		},

		homeDir() {
			return probe(config).then(p => p.home);
		},
	};

	// Fill in the remote's shell name once connected, like localBackend does.
	void probe(config).then(p => { backend.shellKind = p.shellKind; }).catch(() => { /* surfaces on first real use */ });
	return backend;
}
