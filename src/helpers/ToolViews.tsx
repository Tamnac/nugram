import { Index, onCleanup, Show } from 'solid-js';
import type { ToolCall, ToolResult } from './types';
import { thinkingParser, handleLinkClick } from './markdown';
import { toolModules, resolveContent } from './tools/registry';

/** Tool call rendering shared by the message list and run_js's nested call log. */

const MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*=+<>/?';
const randomGlyph = () => MATRIX_CHARS[Math.random() * MATRIX_CHARS.length | 0]!;

/**
 * A row of glyphs as if cut across falling code: each tick a few change and light up
 * (the head of a stream passing), then dim over the next ticks.
 */
export function MatrixLoader() {
	const LEN = 24;
	const glyphs = Array.from({ length: LEN }, () => <span>{randomGlyph()}</span> as HTMLSpanElement);
	const interval = setInterval(() => {
		for (const g of glyphs) if (g.className) g.className = g.className === 'head' ? 'trail' : '';
		for (let i = 0; i < 3; i++) {
			const g = glyphs[Math.random() * LEN | 0]!;
			g.textContent = randomGlyph();
			g.className = 'head';
		}
	}, 120);
	onCleanup(() => clearInterval(interval));
	return <div class='matrixLoader'>{glyphs}</div>;
}

const MAX_NESTED_CHIPS = 8;

/** A tool's chip. With `nested` calls (run_js), their own fainter chips follow on a line of their own. */
export function ToolSummaryItem(props: { 
	toolCall: ToolCall
	toolResult?: ToolResult | undefined
	/** Drawn as a call made by another call: dashed and faded. */
	nested?: boolean
	/** The calling call is still running, so an unsettled result is still coming. */
	pending?: boolean
 }) {
	const mod = toolModules[props.toolCall.function.name];
	const Summary = mod?.Summary;
	const failed = () => props.toolResult?.data?.ok === false
		|| (mod?.failed?.(props.toolCall, props.toolResult) ?? false);
	const nested = () => props.nested ? [] : mod?.nested?.(props.toolResult) ?? [];
	return (<>
		<span class='toolSummaryChip' classList={{
			shellChipFail: failed(),
			toolChipNested: props.nested,
			toolChipPending: props.pending && (!props.toolResult || !!props.toolResult.data?.running),
		}}>
			{Summary
				? <Summary call={props.toolCall} result={props.toolResult} />
				: <span>{props.toolCall.function.name}</span>}
		</span>
		<Show when={nested().length}>
			<span class='toolNestedChips'>
				<Index each={nested().slice(0, MAX_NESTED_CHIPS)}>
					{entry => <ToolSummaryItem nested pending={!!props.toolResult?.data?.running} toolCall={entry().call} toolResult={entry().result} />}
				</Index>
				<Show when={nested().length > MAX_NESTED_CHIPS}>
					<span class='toolNestedMore'>+{nested().length - MAX_NESTED_CHIPS} more</span>
				</Show>
			</span>
		</Show>
	</>);
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
 * Data with an `error` is shown as that text, as in `resolveContent`: the
 * call produced no tool output, so the tool's renderer has nothing to show.
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
