import { createSignal, onCleanup, Show } from 'solid-js';
import type { ToolCall, ToolResult } from './types';
import { thinkingParser, handleLinkClick } from './markdown';
import { toolModules, resolveContent } from './tools/registry';

/** Tool call rendering shared by the message list and run_js's nested call log. */

const MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*=+<>/?';
export function MatrixLoader() {
	const LEN = 24;
	const [text, setText] = createSignal(
		Array.from({ length: LEN }, () => MATRIX_CHARS[Math.random() * MATRIX_CHARS.length | 0]).join('')
	);
	const interval = setInterval(() => {
		setText(Array.from({ length: LEN }, () => MATRIX_CHARS[Math.random() * MATRIX_CHARS.length | 0]).join(''));
	}, 60);
	onCleanup(() => clearInterval(interval));
	return <div class='matrixLoader'>{text()}</div>;
}

export function ToolSummaryItem(props: { 
	toolCall: ToolCall
	toolResult?: ToolResult | undefined
 }) {
	const mod = toolModules[props.toolCall.function.name];
	const Summary = mod?.Summary;
	const failed = () => props.toolResult?.data?.ok === false
		|| (mod?.failed?.(props.toolCall, props.toolResult) ?? false);
	return (
		<span class='toolSummaryChip' classList={{ shellChipFail: failed() }}>
			{Summary
				? <Summary call={props.toolCall} result={props.toolResult} />
				: <span>{props.toolCall.function.name}</span>}
		</span>
	);
}

/** Expanded args view: the tool's own renderer, or inline key/value pairs. */
export function ToolArgsView(props: { call: ToolCall; result?: ToolResult | undefined }) {
	const mod = toolModules[props.call.function.name];
	const Args = mod?.Args;
	if (Args) return <Args call={props.call} result={props.result} />;

	// Generic inline rendering for simple tools
	// Malformed `run` items keep whatever the model sent, which may not be an object.
	const raw = props.call.function.arguments as unknown;
	const args = (typeof raw === 'object' && raw !== null ? raw : { value: raw }) as Record<string, any>;
	return (
		<>
			<span>{props.call.function.name} </span>
			{Object.keys(args).filter(a => a !== 'step').map(a => {
				const val = args[a];
				const display = typeof val === 'string' ? val : JSON.stringify(val);
				return (<>
					<span style={{ opacity: '0.8' }}>{a}: </span>
					<span style={{ opacity: '0.5' }}>{display + '  '}</span>
				</>);
			})}
		</>
	);
}

/**
 * Expanded result view. Structured data renders through the tool's `Result`;
 * a stored `content` override (user edit, or a chat from before structured
 * data) goes to `LegacyResult`. Either falls back to markdown text.
 *
 * `error` data short-circuits to that text, mirroring `resolveContent`: a
 * failure never reached the tool, so its renderer has nothing to show.
 */
export function ToolResultView(props: { result: ToolResult }) {
	return (
		<Show when={props.result.content === undefined && props.result.data} fallback={<StoredTextResult result={props.result} />}>
			{data => {
				const Result = toolModules[props.result.name]?.Result;
				return Result && data().error === undefined ? <Result data={data()} /> : <MarkdownResult result={props.result} />;
			}}
		</Show>
	);
}

function StoredTextResult(props: { result: ToolResult }) {
	const Legacy = toolModules[props.result.name]?.LegacyResult;
	if (!Legacy) return <MarkdownResult result={props.result} />;
	return (
		<Show when={props.result.content !== undefined} fallback={<MarkdownResult result={props.result} />}>
			<Legacy content={props.result.content!} />
		</Show>
	);
}

function MarkdownResult(props: { result: ToolResult }) {
	return <div class='toolResultContent toolScroll' innerHTML={thinkingParser.render(resolveContent(props.result))} onClick={handleLinkClick} />;
}
