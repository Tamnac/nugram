import { isTauri } from '../platform';
import { getTauriCore } from './shared';
import type { Tool, ToolData } from '../types';
import type { ToolModule } from './types';

const definition: Tool = {
	type: 'function',
	function: {
		name: 'shell',
		description: 'Execute a shell command using {shell} in cwd. Returns stdout, stderr, exit code and time for commands >0.5s. Each invocation is a new process in cwd. Set previous=true to retrieve the full untruncated output of the last command.',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'The shell command to execute'
				},
				timeout_secs: {
					type: 'integer',
					description: 'Timeout in seconds (default: 30)'
				},
				previous: {
					type: 'boolean',
					description: 'If true, returns the full untruncated output of the last command instead of running a new one. command and timeout_secs are ignored.'
				}
			},
			required: ['command']
		}
	}
};

// On Tauri, patch the description with the actually-selected shell.
if (isTauri) {
	(async () => {
		try {
			const { invoke } = await getTauriCore();
			const shellPath = await invoke<string>('get_shell_info');
			const lower = shellPath.toLowerCase();
			const kind = lower.includes('bash')
				? 'bash'
				: lower.includes('pwsh')
					? 'PowerShell 7+ (pwsh)'
					: 'Windows PowerShell 5.1';

			definition.function.description = definition.function.description!.replace('{shell}', kind);
		} catch {
			definition.function.description = definition.function.description!.replace('{shell}', 'bash (falls back to pwsh on Windows if bash not found)');
		}
	})();
}

export const shellTool: ToolModule = {
	definition,
	available: isTauri,

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		try {
			const { invoke, Channel } = await getTauriCore();

			// Stream stdout lines via Channel for live UI updates
			let streamBuf = '';
			const onOutput = new Channel<string>();
			onOutput.onmessage = (line: string) => {
				streamBuf += line + '\n';
				ctx.emit?.({ running: true, stdout: streamBuf, stderr: '', previous: !!args?.previous });
			};

			const output = await invoke<{ stdout: string; stderr: string; exit_code: number; duration_ms: number }>('shell', {
				command: args?.command || undefined,
				timeoutSecs: args?.timeout_secs || undefined,
				previous: args?.previous || undefined,
				cwd: ctx.chatFolder || undefined,
				session: ctx.shellSession || undefined,
				onOutput,
			});

			const common = {
				ok: output.exit_code === 0,
				exit_code: output.exit_code,
				duration_ms: output.duration_ms,
				stderr: output.stderr,
			};

			if (args?.previous) return { ...common, previous: true, stdout: output.stdout };

			// Store the trimmed output rather than the full buffer; `previous=true`
			// re-fetches the untruncated version from the backend.
			const fullLen = output.stdout.length;
			const MAX = 30000;
			const truncated = fullLen > MAX;
			return {
				...common,
				stdout: truncated ? output.stdout.slice(-MAX) : output.stdout,
				...(truncated && { truncated, fullLen })
			};
		} catch (error: any) {
			return { ok: false, reason: 'invoke_failed', error: `Shell error: ${error.message || error}` };
		}
	},

	format: data => {
		const body = shellBody(data);
		if (data.running) return body;
		if (data.previous) return `Full previous output:\n\nExit code: ${data.exit_code}\n\n${body}`;
		return `${shellHeader(data)}\n\n${body}`;
	},

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>{args.previous ? 'previous output' : <>$ {args.command}</>}</span>;
	},

	failed: (_call, result) => !!result?.content && /^Exit code: (?!0\b)/.test(result.content),

	Result: props => (
		<ShellOutput
			header={props.data.running ? '' : props.data.previous ? 'Full previous output:' : shellHeader(props.data)}
			body={shellBody(props.data)}
			failed={props.data.ok === false}
		/>
	),

	LegacyResult: props => {
		const lines = () => props.content.split('\n');
		const header = () => lines()[0] || '';
		return (
			<ShellOutput
				header={header()}
				body={lines().slice(1).join('\n').replace(/^\n/, '')}
				failed={/^Exit code: (?!0\b)/.test(header())}
			/>
		);
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		if (args.previous) return <span style={{ opacity: '0.6' }}>retrieving previous output</span>;
		return (
			<div class='toolArgEdit'>
				<pre class='shellCommand'>$ {args.command}</pre>
				{args.timeout_secs ? <span style={{ opacity: '0.5', 'font-size': '0.85em' }}>timeout: {args.timeout_secs}s</span> : null}
			</div>
		);
	},

};

function shellHeader(data: ToolData): string {
	const durationStr = data.duration_ms >= 500 ? ` (${(data.duration_ms / 1000).toFixed(1)}s)` : '';
	return `Exit code: ${data.exit_code}${durationStr}${data.truncated ? ` (${data.fullLen} bytes total)` : ''}`;
}

function shellBody(data: ToolData): string {
	// `previous` output is never trimmed — fetching it is the way to see everything.
	const stdout = data.truncated && !data.previous
		? '...[truncated, use previous=true to get full output]\n' + data.stdout
		: data.stdout ?? '';
	return stdout + (data.stderr ? '\n\nSTDERR:\n' + data.stderr : '');
}

function ShellOutput(props: { header: string; body: string; failed: boolean }) {
	return (
		<div class='toolResultContent'>
			<div class={props.failed ? 'shellHeaderFail' : ''} style={{ opacity: '0.6', 'margin-bottom': '4px' }}>{props.header}</div>
			<pre style={{ margin: '0', 'white-space': 'pre-wrap', 'word-break': 'break-all' }}>{props.body}</pre>
		</div>
	);
}
