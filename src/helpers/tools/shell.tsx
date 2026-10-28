import { isTauri } from '../platform';
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

export const shellTool: ToolModule = {
	returns: '{ exit_code: number, stdout: string, stderr: string, duration_ms: number, noMatch?: true (a search exited 1 with no matches; ok stays true), truncated?: true (stdout holds the last 30000 chars) }',
	definition,
	available: isTauri,

	// The interpreter depends on the machine the command lands on.
	describe: backend => ({
		...definition,
		function: { ...definition.function, description: definition.function.description!.replace('{shell}', backend.shellKind) },
	}),

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		const session = ctx.shellSession || undefined;
		if (ctx.signal?.aborted) return { ok: false, reason: 'cancelled', error: 'Shell error: cancelled before it started' };
		const cancel = () => { ctx.backend.cancelExec(session, call.id).catch(() => {}); };
		ctx.signal?.addEventListener('abort', cancel, { once: true });
		try {
			// Streamed stdout lines drive live UI updates
			let streamBuf = '';
			const output = await ctx.backend.exec({
				command: args?.command || undefined,
				timeoutSecs: args?.timeout_secs || undefined,
				previous: args?.previous || undefined,
				cwd: ctx.chatFolder || undefined,
				session,
				id: call.id,
				onOutput: line => {
					streamBuf += line + '\n';
					ctx.emit?.({ running: true, stdout: streamBuf, stderr: '', previous: !!args?.previous });
				},
			});

			const noMatch = !args?.previous && output.exit_code === 1 && !output.stderr && isSearch(args?.command ?? '');
			const common = {
				ok: output.exit_code === 0 || noMatch,
				...(noMatch && { noMatch }),
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
			return { ok: false, reason: 'exec_failed', error: `Shell error: ${error.message || error}` };
		} finally {
			ctx.signal?.removeEventListener('abort', cancel);
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

	failed: (_call, result) => !!result?.content && FAILED_HEADER.test(result.content),

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
				failed={FAILED_HEADER.test(header())}
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

const FAILED_HEADER = /^Exit code: (?!0\b)(?!1 \(no matches\))/;

/**
 * Search programs exit 1 for "no matches" (2 for real errors). A pipeline's
 * exit code is its last command's, so only the last segment is checked.
 */
const SEARCH_COMMAND = /^(?:rg|grep|egrep|fgrep|findstr|git\s+grep)(?:\.exe)?(?:\s|$)/i;

export function isSearch(command: string): boolean {
	return SEARCH_COMMAND.test(lastSegment(command));
}

/** Last non-empty command of a `&&`/`||`/`;`/`|`/newline chain, respecting quotes. */
function lastSegment(command: string): string {
	let last = '';
	let start = 0;
	let quote = '';
	const cut = (end: number) => {
		const seg = command.slice(start, end).trim();
		if (seg) last = seg;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = '';
			else if (c === '\\' && quote === '"') i++;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === '\\') i++;
		// `&` in a redirection (2>&1) doesn't end a command
		else if (c === ';' || c === '|' || c === '\n' || (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<')) {
			cut(i);
			start = i + 1;
		}
	}
	cut(command.length);
	return last;
}

function shellHeader(data: ToolData): string {
	const durationStr = data.duration_ms >= 500 ? ` (${(data.duration_ms / 1000).toFixed(1)}s)` : '';
	return `Exit code: ${data.exit_code}${data.noMatch ? ' (no matches)' : ''}${durationStr}${data.truncated ? ` (${data.fullLen} bytes total)` : ''}`;
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
			<pre class='toolScroll' style={{ margin: '0', 'white-space': 'pre-wrap', 'word-break': 'break-all' }}>{props.body}</pre>
		</div>
	);
}
