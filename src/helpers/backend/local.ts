/** The machine the app runs on, via Tauri's fs plugin and `shell` command. */
import { isTauri } from '../platform';
import type { Backend, ExecOptions, ExecResult } from './index';

let _fs: Promise<typeof import('@tauri-apps/plugin-fs')> | null = null;
const fs = () => (_fs ??= import('@tauri-apps/plugin-fs'));

let _core: Promise<typeof import('@tauri-apps/api/core')> | null = null;
const core = () => (_core ??= import('@tauri-apps/api/core'));

const isWindows = navigator.platform?.startsWith('Win') ?? false;

export const localBackend: Backend = {
	id: 'local',
	label: 'This machine',
	paths: { sep: isWindows ? '\\' : '/', windows: isWindows },
	shellKind: 'bash (falls back to pwsh on Windows if bash not found)',

	async exec(opts: ExecOptions): Promise<ExecResult> {
		const { invoke, Channel } = await core();
		// The command always expects a channel, whether or not anyone listens.
		const onOutput = new Channel<string>();
		if (opts.onOutput) onOutput.onmessage = opts.onOutput;
		return invoke<ExecResult>('shell', {
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
		if (!isTauri) return;
		const { invoke } = await core();
		await invoke('cancel_shell', { session, id });
	},

	async stat(path: string) {
		const info = await (await fs()).stat(path);
		return { isDirectory: info.isDirectory };
	},

	async readText(path: string) {
		return (await fs()).readTextFile(path);
	},

	async readBinary(path: string) {
		return (await fs()).readFile(path);
	},

	async writeText(path: string, content: string) {
		return (await fs()).writeTextFile(path, content);
	},

	async mkdir(path: string) {
		await (await fs()).mkdir(path, { recursive: true });
	},

	async readDir(path: string) {
		return (await (await fs()).readDir(path)).map(e => ({ name: e.name, isDirectory: e.isDirectory }));
	},

	async homeDir() {
		const { homeDir } = await import('@tauri-apps/api/path');
		return (await homeDir()).replace(/[/\\]$/, '');
	},
};

// Name the real interpreter once, for the shell tool's description.
if (isTauri) void (async () => {
	try {
		const { invoke } = await core();
		const shellPath = (await invoke<string>('get_shell_info')).toLowerCase();
		localBackend.shellKind = shellPath.includes('bash')
			? 'bash'
			: shellPath.includes('pwsh')
				? 'PowerShell 7+ (pwsh)'
				: 'Windows PowerShell 5.1';
	} catch { /* keep the generic description */ }
})();
