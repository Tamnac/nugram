import { createSignal, Show, createEffect, onCleanup, Setter, For, batch, createRoot, type JSX } from 'solid-js';
import { SetStoreFunction } from 'solid-js/store'
import { Remarkable } from 'remarkable';
import type { ChatMessage, ToolApprove, ToolCall, ToolResult, ProviderConfig, Provider } from './helpers/types'
import { providerNames } from './helpers/types'
import { getMessageContent, getMessageThinking, getMessageVersionCount, addMessageVersion } from './helpers/messages'
import { typeHelper, tabComplete } from './input'
import { thinkingParser, handleLinkClick, setLinkCwd } from './helpers/markdown'
import { attachFromTransfer, loadTextFile } from './helpers/attachments'
import { ChatImage } from './helpers/Comps'
import { FileContent, type FileContentData } from './helpers/fileContent'
import { toolModules, resolveContent, isPending, stepOf } from './helpers/tools'
import { runningAgentsByCallId } from './helpers/agent';
import { TbOutlineTrashX, TbOutlineRefresh, TbOutlinePencil, TbOutlineClipboard,
	TbOutlineChevronDown, TbOutlineChevronUp, TbOutlinePlus, TbOutlineSparkles,
	TbOutlineEraser, TbOutlineClock, TbOutlineCoins, TbOutlineSpeedboat,
	TbOutlineBrain, TbOutlineMessage, TbOutlinePlayerStop,
	TbOutlineArrowBarDown, TbOutlineGitFork, TbOutlineCopy, TbOutlineX, TbOutlineCheck } from 'solid-icons/tb'
import type { IconTypes } from 'solid-icons'
import type { StreamingResult } from './helpers/streaming'

// Static markup for an icon component, for use in imperatively built DOM
let copyIconMarkup = '';
const getCopyIconMarkup = () => {
	if (!copyIconMarkup) createRoot(dispose => {
		const holder = document.createElement('div');
		holder.appendChild(<TbOutlineCopy size={16} /> as Node);
		copyIconMarkup = holder.innerHTML;
		dispose();
	});
	return copyIconMarkup;
};

const standardTags = new Set([
	'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'select', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'
// iframe intentionally excluded
]);

const parser = new Remarkable({ html: true, typographer: false });
parser.block.ruler.disable(['code'])

// Renderer overrides — these only fire for tokens remarkable parsed as text/HTML,
// never for code block content (which goes through separate fence/code rules).

// Escape non-standard HTML tags (e.g. <Character>) so they render as text.
const defaultHtmltag = parser.renderer.rules.htmltag;
parser.renderer.rules.htmltag = function(tokens: any[], idx: number, options: any, env: any) {
	const content = tokens[idx].content;
	const m = content.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
	if (m && !standardTags.has(m[1].toLowerCase()))
		return content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return defaultHtmltag(tokens, idx, options, env);
};

// Wrap "quoted" or “curly-quoted” inline text in a styled span (dialogue
// highlighting), always rendering with curly quotes. This runs as a core rule
// after inline parsing, so formatting inside quotes (e.g. "**bold**") stays
// inside the highlighted span while fenced code blocks are never touched.
function quoteTextToken(token: any, content: string) {
	return { ...token, content };
}

function quoteHtmlToken(content: string, level: number) {
	return { type: 'htmltag', content, level };
}

parser.core.ruler.after('smartquotes', 'highlight_quotes', function(state: any) {
	for (const blockToken of state.tokens) {
		if (blockToken.type !== 'inline') continue;

		const output: any[] = [];
		let buffer: any[] | undefined;
		let quoteOpen = '';
		let quoteToken: any;
		let quoteLevel = 0;
		const append = (token: any) => (buffer ?? output).push(token);
		const flushUnmatchedQuote = () => {
			if (!buffer) return;
			output.push(quoteTextToken(quoteToken, quoteOpen), ...buffer);
			buffer = undefined;
			quoteOpen = '';
			quoteToken = undefined;
		};

		for (const token of blockToken.children) {
			if (buffer && token.level < quoteLevel)
				flushUnmatchedQuote();

			if (token.type !== 'text') {
				append(token);
				continue;
			}

			let lastIndex = 0;
			token.content.replace(/["“”]/g, (quote: string, index: number) => {
				if (index > lastIndex)
					append(quoteTextToken(token, token.content.slice(lastIndex, index)));

				if (buffer && quote !== '“' && token.level === quoteLevel) {
					output.push(
						quoteHtmlToken('<span class="quote">', quoteLevel),
						quoteTextToken(token, '“'),
						...buffer,
						quoteTextToken(token, '”'),
						quoteHtmlToken('</span>', quoteLevel),
					);
					buffer = undefined;
					quoteOpen = '';
				} else if (!buffer && quote !== '”') {
					buffer = [];
					quoteOpen = quote;
					quoteToken = token;
					quoteLevel = token.level;
				} else {
					append(quoteTextToken(token, quote));
				}

				lastIndex = index + quote.length;
				return quote;
			});

			if (lastIndex < token.content.length)
				append(quoteTextToken(token, token.content.slice(lastIndex)));
		}

		flushUnmatchedQuote();
		blockToken.children = output;
	}
	return false;
}, {});

const names = {
	"user": "You",
	"assistant": "Assistant",
	"system": "System",
	"tool": "Tool Result"
}

// SVG icon sprite - render each solid-icon once into <symbol>, then reference via <use>
const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
sprite.style.display = 'none';
document.body.prepend(sprite);

function spriteify(IconComp: IconTypes, id: string) {
	const rendered = IconComp({ size: 24 }) as unknown as SVGElement;
	const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
	symbol.id = id;
	symbol.setAttribute('viewBox', rendered.getAttribute('viewBox') || '0 0 24 24');
	while (rendered.firstChild) symbol.appendChild(rendered.firstChild);
	sprite.appendChild(symbol);
}

createRoot(() => {
	spriteify(TbOutlineTrashX, 'i-trash');
	spriteify(TbOutlineRefresh, 'i-refresh');
	spriteify(TbOutlinePencil, 'i-pencil');
	spriteify(TbOutlineClipboard, 'i-clipboard');
	spriteify(TbOutlineChevronDown, 'i-chevron-down');
	spriteify(TbOutlineChevronUp, 'i-chevron-up');
	spriteify(TbOutlinePlus, 'i-plus');
	spriteify(TbOutlineSparkles, 'i-sparkles');
	spriteify(TbOutlineEraser, 'i-eraser');
	spriteify(TbOutlineClock, 'i-clock');
	spriteify(TbOutlineCoins, 'i-coins');
	spriteify(TbOutlineSpeedboat, 'i-speedboat');
	spriteify(TbOutlineBrain, 'i-brain');
	spriteify(TbOutlineMessage, 'i-message');
	spriteify(TbOutlinePlayerStop, 'i-player-stop');
	spriteify(TbOutlineArrowBarDown, 'i-arrow-bar-down');
	spriteify(TbOutlineGitFork, 'i-git-fork');
	spriteify(TbOutlineCopy, 'i-copy');
	spriteify(TbOutlineX, 'i-x');
	spriteify(TbOutlineCheck, 'i-check');
});

export function Icon(props: { name: string; size?: number }) {
	return (
		<svg width={props.size || 24} height={props.size || 24} viewBox="0 0 24 24"
			stroke="currentColor" fill="none" stroke-width="2"
			stroke-linecap="round" stroke-linejoin="round">
			<use href={`#i-${props.name}`} />
		</svg>
	);
}

function formatTime(ms: number | undefined): string {
	if (ms === undefined || ms === 0) return '0ms';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatTps(tps: number | undefined): string {
	if (tps === undefined || tps === 0) return '0';
	return tps.toFixed(2);
}

function formatDateTime(ms: number | undefined): string {
	if (!ms) return '';
	return new Date(ms).toLocaleString(undefined, {
		year: 'numeric', month: 'short', day: 'numeric',
		hour: '2-digit', minute: '2-digit',
	});
}

function getLastLine(text: string | undefined): string {
	if (!text) return '';
	const lines = text.split('\n').filter(line => line.trim() !== '');
	return lines[lines.length - 1] || '';
}



const sanitizeRe = /\s+on\w+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const jsUrlRe = /\s+(href|src|action)\s*=\s*(["'])\s*javascript:/gi;

function sanitize(html: string): string {
	return html.replace(sanitizeRe, '').replace(jsUrlRe, ' $1=$2');
}

function render(text: string): string {
	return sanitize(parser.render(text));
}


const MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*=+<>/?';
function MatrixLoader() {
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

function ToolSummaryItem(props: { 
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
function ToolArgsView(props: { call: ToolCall; result?: ToolResult | undefined }) {
	const mod = toolModules[props.call.function.name];
	const Args = mod?.Args;
	if (Args) return <Args call={props.call} result={props.result} />;

	// Generic inline rendering for simple tools
	const args = props.call.function.arguments as Record<string, any>;
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
function ToolResultView(props: { result: ToolResult }) {
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
	return <div class='toolResultContent' innerHTML={thinkingParser.render(resolveContent(props.result))} onClick={handleLinkClick} />;
}

function renderThinking(text: string) {
	return thinkingParser.render(text);
}

async function processLocalImages(container: HTMLElement, imageFolderFiles: Map<string, FileSystemFileHandle>) {
	const images = container.querySelectorAll('img[data-local-src]');

	for (const img of images) {
		const filename = img.getAttribute('data-local-src');
		if (!filename) continue;

		const imageHandle = imageFolderFiles.get(filename);
		const htmlImg = img as HTMLImageElement;

		if (imageHandle) {
			try {
				const file = await imageHandle.getFile();
				const url = URL.createObjectURL(file);
				htmlImg.src = url;
				htmlImg.onload = () => URL.revokeObjectURL(url);
			} catch (error) {
				htmlImg.alt = `Failed to load ${filename}`;
				htmlImg.style.opacity = '0.5';
			}
		} else {
			htmlImg.alt = `${filename} not found in folder`;
			htmlImg.style.opacity = '0.5';
		}
	}
}

// Function to convert HTML image references to local image elements
function convertLocalImageRefs(html: string, imageFolderFiles: Map<string, FileSystemFileHandle>): string {
	const imageRegex = /<img[^>]+src="(?!https?:\/\/)([^"]+\.(jpg|jpeg|png|gif|webp|bmp|svg))"[^>]*>/gi;

	return html.replace(imageRegex, (match, filename) => {
		const altMatch = match.match(/alt="([^"]*)"/);
		const alt = altMatch ? altMatch[1] : '';

		if (imageFolderFiles.has(filename)) {
			return `<img data-local-src="${filename}" alt="${alt}" style="max-width: 100%; height: auto;" loading="lazy" />`;
		}
		return `<div style="opacity: 0.5; font-style: italic;">📁 ${filename} (not found in selected folder)</div>`;
	});
}

function addCopyButtonsToCodeBlocks(container: HTMLElement) {
	if (!container) return;

	const codeBlocks = container.querySelectorAll('pre code');

	codeBlocks.forEach(codeBlock => {
		const preElement = codeBlock.parentElement;
		if (!preElement || preElement.classList.contains('copy-button-added')) return;

		// Create container wrapper
		const containerWrapper = document.createElement('div');
		containerWrapper.className = 'codeBlockContainer';

		// Add styling classes to the code block
		preElement.className = 'codeBlock';
		preElement.classList.add('copy-button-added');

		// Create copy button
		const copyButton = document.createElement('button');
		copyButton.className = 'copyButton';
		copyButton.innerHTML = getCopyIconMarkup();
		copyButton.title = 'Copy';
		copyButton.onclick = async () => {
			try {
				const textToCopy = codeBlock.textContent || '';
				await navigator.clipboard.writeText(textToCopy);
				copyButton.textContent = 'Copied!';
				copyButton.classList.add('copied');
				setTimeout(() => {
					copyButton.innerHTML = getCopyIconMarkup();
					copyButton.classList.remove('copied');
				}, 2000);
			} catch (err) {
				console.error('Failed to copy text: ', err);
				copyButton.textContent = 'Failed';
				setTimeout(() => {
					copyButton.innerHTML = getCopyIconMarkup();
				}, 2000);
			}
		};

		// Wrap the pre element and add button
		preElement.parentNode?.insertBefore(containerWrapper, preElement);
		containerWrapper.appendChild(preElement);
		containerWrapper.appendChild(copyButton);
	});
}

interface MessageArgs {
	index: number;
	message: ChatMessage;
	setMessages: SetStoreFunction<ChatMessage[]>
	deleteMessage: (index: number) => void;
	sendMessage: (redo: number) => Promise<StreamingResult | undefined>;
	cut: number;
	setCut: Setter<number>;
	imageFolderFiles: Map<string, FileSystemFileHandle>;
	containerRef: HTMLDivElement;
	activeStreams: Map<ChatMessage, { controller: AbortController; versionIndex: number }[]>;
	providers: Record<Provider, ProviderConfig>;
	pendingPermissions?: Array<{ id: string; toolCall: any; resolve: (result: true | string) => void; outside?: boolean }> | undefined;
	resolvePermission?: ((id: string, approved: boolean, mode?: ToolApprove) => void) | undefined;
	forkChat?: ((index: number) => void) | undefined;
}

export function Message(props: MessageArgs) {
	const providerName = (key: string) => {
		const cfg = props.providers?.[key as Provider];
		return cfg?.name || (providerNames as Record<string, string>)[key] || key;
	};
	const [editing, setEditing] = createSignal(false);
	const [thinkEx, setThinkEx] = createSignal({expanded: false, auto: false});
	const [menuOpen, setMenuOpen] = createSignal(false);
	let msgBox!: HTMLTextAreaElement;
	let menuContainer!: HTMLDivElement;
	let messageContentRef!: HTMLDivElement;
	let thinkingContentRef: HTMLDivElement | undefined;
	let streamingRo: ResizeObserver | undefined;

	function postProcessContent() {
		if (!messageContentRef) return;
		requestAnimationFrame(async () => {
			addCopyButtonsToCodeBlocks(messageContentRef);
			if (props.imageFolderFiles.size > 0) {
				await processLocalImages(messageContentRef, props.imageFolderFiles);
			}
		});
	}

	// Re-run when content changes (streaming, version switch), editing ends, or image folder changes
	createEffect(() => {
		const content = getMessageContent(props.message);
		const folderFiles = props.imageFolderFiles;

		if (messageContentRef && !editing() && content) {
			postProcessContent();
		}
	});

	createEffect(() => {
		const entries = props.activeStreams.get(props.message);
		if (entries?.some(e => e.versionIndex === (props.message.currentVersionIndex || 0))) 
			setThinkEx({ expanded: true, auto: true });
		else if (thinkEx().auto) 
			setThinkEx({ expanded: false, auto: false});
	});

	// During streaming, use contain:size on the bubble and manually sync height via ResizeObserver
	// This prevents every text chunk from triggering layout up the tree even when it doesn't change size
	createEffect(() => {
		const streaming = isCurrentVersionStreaming();
		const bubble = props.containerRef;
		if (!streaming || !bubble) return;

		// Snapshot current height before applying contain:size
		bubble.style.height = bubble.offsetHeight + 'px';
		bubble.style.contain = 'strict';
		bubble.classList.add('streamingReveal');

		let lastH = bubble.offsetHeight;
		streamingRo = new ResizeObserver(() => {
			let h = 0;
			for (const child of bubble.children) {
				const el = child as HTMLElement;
				const style = getComputedStyle(el);
				h += el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
			}
			
			if (h !== lastH) {
				lastH = h;
				bubble.style.height = h + 'px';
				// performance.mark('stream-resize');
			}
		});

		// Observe the content areas that change during streaming
		if (messageContentRef) streamingRo.observe(messageContentRef);
		if (thinkingContentRef) streamingRo.observe(thinkingContentRef);

		onCleanup(() => {
			streamingRo!.disconnect();
			streamingRo = undefined;
			bubble.style.contain = '';
			bubble.style.height = '';
			bubble.classList.remove('streamingReveal');
		});
	});

	function renderPreview(text: string): string {
		if (thinkEx().expanded)	return '' // avoid duplication
		return thinkingParser.renderInline(text);
	}

	function toggleMenu() { setMenuOpen(prev => !prev); }

	function deleteMsg() {
		// console.log('deleting message', props.index);
		props.deleteMessage(props.index);
	}

	function redoMessage() {
		// console.log("redoing message at index", props.index);
		props.sendMessage(props.index);
	}

	function copyMessage() {
		navigator.clipboard.writeText(getMessageContent(props.message));
	}

	function addNewEmptyVersion() {
		props.setMessages(props.index, prev => 
			addMessageVersion(prev, { content: '' })
		);
		setMenuOpen(false);
		setEditing(true);
	}

	function finishEdit(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			e.preventDefault();
			const target = e.target as HTMLTextAreaElement;
			const result = tabComplete(target.value, target.selectionStart);

			const field = target.getAttribute('data-field') as keyof ChatMessage || 'content';
			const versionIndex = props.message.currentVersionIndex || 0;
			props.setMessages(props.index, field, versionIndex, result.text);
			touchEdited(versionIndex);
			if (result.cursorPos !== undefined) {
				target.setSelectionRange(result.cursorPos, result.cursorPos);
			}
		}
		else if (e.key === 'Enter') {
			if (e.ctrlKey) {
				e.preventDefault();
				setEditing(false);
			} else {
				const target = e.target as HTMLTextAreaElement;
				requestAnimationFrame(() => { target.style.height = target.scrollHeight + 'px'; });
			}
		}
	}

	/** Stamp editedAt on a version's timing entry, creating it if missing */
	function touchEdited(versionIndex: number) {
		props.setMessages(props.index, 'timing', prev => {
			const arr = prev ? prev.slice() : [];
			arr[versionIndex] = { ...arr[versionIndex], editedAt: Date.now() };
			return arr;
		});
	}

	function editText(e: InputEvent, field: keyof ChatMessage = 'content') {
		if (e.inputType === 'insertText' && (e as any).data === '\t') {
			e.preventDefault();
		}
		const target = e.target as HTMLTextAreaElement;
		const loc = target.selectionStart;
		const newValue = e.inputType === 'insertText' ? typeHelper(target.value, loc) : target.value;
		const versionIndex = props.message.currentVersionIndex || 0;
		props.setMessages(props.index, field, versionIndex, newValue);
		touchEdited(versionIndex);
		target.setSelectionRange(loc, loc);
	}

	const images = () => props.message.images?.[currentVersionIndex()];
	const files = () => props.message.files?.[currentVersionIndex()];
	const [expandedFile, setExpandedFile] = createSignal<{ id: string; data: FileContentData }>();

	function updateImages(update: (prev: string[]) => string[]) {
		const vi = currentVersionIndex();
		props.setMessages(props.index, 'images', prev => {
			const arr = prev ? prev.slice() : [];
			while (arr.length <= vi) arr.push([]);
			arr[vi] = update(arr[vi] || []);
			return arr;
		});
		touchEdited(vi);
	}

	async function pasteImages(e: ClipboardEvent) {
		if (!e.clipboardData?.files.length) return;
		e.preventDefault();
		const ids = await attachFromTransfer(e.clipboardData);
		if (ids.length) updateImages(prev => [...prev, ...ids]);
	}

	const currentVersionIndex = () => props.message.currentVersionIndex || 0;
	const usage = () => props.message.usage?.[currentVersionIndex()];
	const timing = () => props.message.timing?.[currentVersionIndex()];
	const totalTime = () => timing ? (timing()?.reasoning_time || 0) + (timing()?.message_time || 0) : 0;

	const streamEntries = () => props.activeStreams.get(props.message);
	const isAnyVersionStreaming = () => (streamEntries()?.length ?? 0) > 0;
	const currentStreamEntry = () => streamEntries()?.find(e => e.versionIndex === currentVersionIndex());
	const isCurrentVersionStreaming = () => currentStreamEntry() !== undefined;

	function stopVersionStream() {
		currentStreamEntry()?.controller.abort();
	}

	function VersionPicker() {
		return (
			<Show when={getMessageVersionCount(props.message) > 1}>
				<Show when={isCurrentVersionStreaming()}>
					<button class='mbutton stopVersionButton versionStreaming' onClick={stopVersionStream} title="Stop this stream">
						<Icon name="player-stop" size={15} />
					</button>
				</Show>
				<Show when={isAnyVersionStreaming() && !isCurrentVersionStreaming()}>
					<span class='versionStreamingIndicator' title="Another version is streaming">●</span>
				</Show>
				<span class='versionNav'>
					<button
						class='mbutton'
						onClick={() => props.setMessages(props.index, 'currentVersionIndex',
							prev => prev !== undefined && prev > 0 ? prev - 1 : 0)}
						title="Previous version"
					>
						←
					</button>
					<span class='messageInfo' classList={{ ['versionStreaming']: isCurrentVersionStreaming() }}>
						{(props.message.currentVersionIndex || 0) + 1} / {getMessageVersionCount(props.message)}
					</span>
					<button
						class='mbutton'
						onClick={() => props.setMessages(props.index, 'currentVersionIndex', prev => {
							const end = getMessageVersionCount(props.message) - 1;
							return prev !== undefined && prev < end ? prev + 1 : end;
						})}
						title="Next version"
					>
						→
					</button>
				</span>
			</Show>
		);
	}

	function MessageMenu() {
		return (
			<>
				<div class='messageMenuGrid'>
					<div class='messageMenuColumn'>
						<Show when={props.message.models?.[currentVersionIndex()]}>
							<div class='menuInfoItem menuInfoItemPrimary'>
								<Icon name="brain" size={14} />
								<span>{props.providers && props.message.providers?.[currentVersionIndex()] ? `${providerName(props.message.providers[currentVersionIndex()])} · ` : ''}{props.message.models?.[currentVersionIndex()]}</span>
							</div>
						</Show>
						<Show when={usage()}>
							<div class='menuInfoItem'>
								<Icon name="coins" size={14} />
								<span>Prompt: {usage()?.prompt_tokens}</span>
							</div>
							<Show when={usage()?.cached_tokens !== undefined}>
								<div class='menuInfoItem'>
									<Icon name="coins" size={14} />
									<span>Cached: {usage()?.cached_tokens}</span>
								</div>
							</Show>
							<div class='menuInfoItem'>
								<Icon name="message" size={14} />
								<span>Tokens: {usage()?.message_tokens} | {usage()?.reasoning_tokens}</span>
							</div>
							<div class='menuInfoItem'>
								<Icon name="coins" size={14} />
								<span>Cost: ${((usage()?.prompt_cost || 0) + (usage()?.message_cost || 0)).toFixed(6)}</span>
							</div>
						</Show>
					</div>
					<div class='messageMenuColumn'>
						<Show when={timing()?.time_to_first_token !== undefined || timing()?.message_time !== undefined}>
							<div class='menuInfoItem'>
								<Icon name="clock" size={14} />
								<span>TTFT: {formatTime(timing()?.time_to_first_token)}</span>
							</div>
							<div class='menuInfoItem'>
								<Icon name="speedboat" size={14} />
								<span>TPS: {formatTps(timing()?.tokens_per_second)} t/s</span>
							</div>
							<div class='menuInfoItem'>
								<Icon name="brain" size={14} />
								<span>Reasoning: {formatTime(timing()?.reasoning_time)}</span>
							</div>
							<div class='menuInfoItem'>
								<Icon name="message" size={14} />
								<span>Message: {formatTime(timing()?.message_time)}</span>
							</div>
							<div class='menuInfoItem'>
								<Icon name="clock" size={14} />
								<span>Total: {formatTime(totalTime())}</span>
							</div>
						</Show>
						<Show when={timing()?.createdAt}>
							<div class='menuInfoItem'>
								<Icon name="clock" size={14} />
								<span>Created: {formatDateTime(timing()?.createdAt)}</span>
							</div>
						</Show>
						<Show when={timing()?.editedAt}>
							<div class='menuInfoItem'>
								<Icon name="eraser" size={14} />
								<span>Edited: {formatDateTime(timing()?.editedAt)}</span>
							</div>
						</Show>
					</div>
					<div class='messageMenuButtonsGrid'>
						<button onClick={() => {
							if (props.cut === props.index) props.setCut(-1);
							else props.setCut(props.index);
							setMenuOpen(false);
						}} class='messageMenuButton'>
							{props.cut === props.index ? <Icon name="chevron-up" size={14} /> : <Icon name="arrow-bar-down" size={14} />}
							<span>{props.cut === props.index ? 'Uncut' : 'Cut Here'}</span>
						</button>

						<button onClick={addNewEmptyVersion} class='messageMenuButton'>
							<Icon name="plus" size={14} />
							<span>Add Version</span>
						</button>

						<button onClick={() => {
							const versionIndex = props.message.currentVersionIndex || 0;
							props.setMessages(props.index, 'content', versionIndex,
								prev => msgClean(prev));
							touchEdited(versionIndex);
							setMenuOpen(false);
						}} class='messageMenuButton'>
							<Icon name="sparkles" size={14} />
							<span>Clean</span>
						</button>

						<button onClick={() => {
							const versionIndex = props.message.currentVersionIndex || 0;
							props.setMessages(props.index, 'content', versionIndex, starScrubber);
							touchEdited(versionIndex);
							setMenuOpen(false);
						}} class='messageMenuButton'>
							<Icon name="eraser" size={14} />
							<span>Scrub Asterisks</span>
						</button>

						<Show when={props.forkChat}>
							<button onClick={() => {
								props.forkChat!(props.index);
								setMenuOpen(false);
							}} class='messageMenuButton' title='Create a new chat that shares messages up to here'>
								<Icon name="git-fork" size={14} />
								<span>Fork Here</span>
							</button>
						</Show>
					</div>
				</div>
			</>
		)
	}

	function HeaderButtons() {
		return (
				<span class='messageHeaderRowInline'>
					<VersionPicker />

					<Show when={props.message.role === 'assistant'}>
						<button class='mbutton' onclick={redoMessage} disabled={props.message.role === 'user'}>
							<Icon name="refresh" size={17} />
						</button>
					</Show>

					<button class='mbutton' onmousedown={(e) => {
						if (e.detail === 2) { deleteMsg(); return; }
						if (!e.shiftKey) {
							const btn = e.currentTarget;
							btn.classList.add('shake');
							setTimeout(() => btn.classList.remove('shake'), 300);
							return;
						}
						deleteMsg();
					}}
						title="Shift+Click or Double-Click to delete"
					>
						<Icon name="trash" size={17} />
					</button>

					<button class='mbutton' onclick={copyMessage}><Icon name="clipboard" size={17} /></button>
					<button class='mbutton' onclick={() => setEditing(p => !p)}><Icon name="pencil" size={17} /></button>
					<div class='menuContainer' ref={menuContainer}> {/* three dots menu */}
						<button class='mbutton' onClick={(e) => {
							e.stopPropagation();
							toggleMenu();
						}}>
							<Show when={menuOpen()} fallback={<Icon name="chevron-down" size={17} />}>
								<Icon name="chevron-up" size={17} />
							</Show>
						</button>
					</div>
				</span>
		)
	}

	function MessageHeader() {
		return (
			<div class='messageHeaderRow'>
				<span class='mtoprow'>
					<span class='messageRole'>
						{names[props.message.role] || props.message.role}
					</span>
					<span class='messageInfo'>#{props.index}</span>
				</span>

				<HeaderButtons />
			</div>
		)
	}

	function Menu() {
		return (
			<Show when={menuOpen()}>
				<MessageMenu />
				<div class="messageDivider" aria-hidden="true" />
			</Show>
		)
	}

	/** Assistant tool call with no text: the tool preview row hosts the header buttons. */
	const combined = () => props.message.role === 'assistant'
		&& !!props.message.tool_calls?.[currentVersionIndex()]
		&& !getMessageContent(props.message).trim();

	return (
		<>
			<Show when={!combined()}>
				<MessageHeader />
				<Menu />
			</Show>

			<Show when={getMessageThinking(props.message) && !editing()}>
				<details class='messageThink' open={thinkEx().expanded} 
					ontoggle={(e: Event) => {
						setThinkEx({expanded: (e.target as HTMLDetailsElement).open, auto: thinkEx().auto});
					}}
					onclick={(e: MouseEvent) => { 
						if (!(e.target as HTMLElement).closest('summary')) { 
							const sel = window.getSelection(); 
							if (sel && sel.toString().length > 0) return; 
							setThinkEx(p => ({expanded: !p.expanded, auto: false})); 
						} 
					}}>
					<summary class='messageThinkLabel' innerHTML={renderPreview(getLastLine(getMessageThinking(props.message) || ''))}></summary>
					<Show when={thinkEx().expanded}>
						<div ref={el => { thinkingContentRef = el; streamingRo?.observe(el); }} class='messageThinkContent' innerHTML={renderThinking(getMessageThinking(props.message) || '')} onClick={handleLinkClick} />
					</Show>
				</details>
			</Show>
			<Show when={files()?.length}>
				<div class='fileAttachmentList messageFiles'>
					<For each={files()}>{file => (
						<div>
							<button class='fileAttachmentChip' onClick={async () => {
								if (expandedFile()?.id === file.id) return setExpandedFile();
								const data = await loadTextFile(file);
								if (data) setExpandedFile({ id: file.id, data });
							}}>{file.path}</button>
							<Show when={expandedFile()?.id === file.id && expandedFile()?.data}>
								{data => <FileContent data={data()} />}
							</Show>
						</div>
					)}</For>
				</div>
			</Show>
			<Show when={images()?.length}>
				<div class='imageStrip messageImages'>
					<For each={images()}>
						{(id, i) => <ChatImage src={id} onRemove={editing() ? () => updateImages(prev => prev.filter((_, j) => j !== i())) : undefined} />}
					</For>
				</div>
			</Show>
			<Show when={editing()} fallback={
				<div ref={messageContentRef} class='messageContent' innerHTML={convertLocalImageRefs(render(getMessageContent(props.message)), props.imageFolderFiles)} onClick={handleLinkClick} />
			}>
				<Show when={props.message.role !== 'user' && getMessageThinking(props.message)}>
					<textarea class='messageEdit messageEditContained messageThinkEdit'
						ref={el => requestAnimationFrame(() => { el.style.height = Math.min(el.scrollHeight, 300) + 'px'; })}
						value={getMessageThinking(props.message) || ''}
						onInput={e => editText(e, 'thinking')}
						onkeydown={finishEdit}
						data-field="thinking" />
				</Show>
				<textarea class='messageEdit messageEditContained'
					ref={el => { msgBox = el; requestAnimationFrame(() => { el.style.height = el.scrollHeight + 'px'; }); }}
					value={getMessageContent(props.message)} onInput={editText} onkeydown={finishEdit} onPaste={pasteImages} data-field="content" />
			</Show>
			<Show when={props.message.tool_calls?.[currentVersionIndex()]}>
				<ToolCalls
					toolCalls={props.message.tool_calls![currentVersionIndex()]}
					toolResults={props.message.tool_results?.[currentVersionIndex()] || []}
					pendingPermissions={props.pendingPermissions}
					resolvePermission={props.resolvePermission}
					editing={editing}
					currentVersionIndex={currentVersionIndex}
					setMessages={props.setMessages}
					messageIndex={props.index}
					header={combined() ? <HeaderButtons /> : undefined}
					menu={combined() ? <Menu /> : undefined}
				/>
			</Show>
		</>
	)
}

interface ToolCallsArgs {
	toolCalls: ToolCall[];
	toolResults: ToolResult[];
	pendingPermissions?: Array<{ id: string; toolCall: any; resolve: (result: true | string) => void; outside?: boolean }> | undefined;
	resolvePermission?: ((id: string, approved: boolean, mode?: ToolApprove) => void) | undefined;
	editing: () => boolean;
	currentVersionIndex: () => number;
	setMessages: SetStoreFunction<ChatMessage[]>;
	messageIndex: number;
	/** Message header buttons, hosted in the preview row when the message has no text. */
	header?: JSX.Element;
	/** Message info menu, shown under the preview row when the header is hosted here. */
	menu?: JSX.Element;
}

function ToolCalls(props: ToolCallsArgs) {
	const [toolsEx, setToolsEx] = createSignal(false);

	// Steps only mean something relative to each other, so stay quiet on a flat turn.
	const stepped = () => new Set((props.toolCalls || []).map(stepOf)).size > 1;
	// Shown in execution order rather than the order the model emitted them in.
	const calls = () => stepped()
		? [...props.toolCalls].sort((a, b) => stepOf(a) - stepOf(b))
		: props.toolCalls || [];
	// One preview row per step; a flat turn is a single row.
	const chipRows = () => {
		if (!stepped()) return [calls()];
		const rows = new Map<number, ToolCall[]>();
		for (const call of calls()) {
			const step = stepOf(call);
			if (!rows.has(step)) rows.set(step, []);
			rows.get(step)!.push(call);
		}
		return [...rows.values()];
	};

	const hasPending = () => props.pendingPermissions?.length &&
		props.toolCalls.some(tc => props.pendingPermissions?.some(p => p.id === tc.id));
	// Auto-expand when permission is pending
	createEffect(() => { if (hasPending()) setToolsEx(true); });

	// Click anywhere in the block toggles, except interactive areas and text selections.
	const toggle = (e: MouseEvent) => {
		const el = e.target as HTMLElement;
		if (el.closest('.permissionActions, .toolHeaderButtons, .toolMenu')) return;
		const sel = window.getSelection();
		if (sel && sel.toString().length > 0) return;
		setToolsEx(p => !p);
	};

	return (
		<div class='toolCallContainer' classList={{ toolCallContainerBare: !!props.header }} onclick={toggle}>
			<div class='toolHeader'>
				<span class='toolChips'>
				<For each={chipRows()}>
				{row => (
					<span class='toolChipRow'>
						<For each={row}>
						{call => {
							const result = () => props.toolResults.find(r => r.tool_call_id === call.id);
							return <ToolSummaryItem toolCall={call} toolResult={result()} />;
						}}
						</For>
					</span>
				)}
				</For>
				</span>
				<Show when={props.header}>
					<span class='toolHeaderButtons'>{props.header}</span>
				</Show>
			</div>
			<Show when={props.menu}>
				<div class='toolMenu'>{props.menu}</div>
			</Show>
			<Show when={toolsEx()}>
				<For each={calls()}>
					{(toolCall, i) => {
						const result = () => props.toolResults.find(r => r.tool_call_id === toolCall.id);
						const permissionPending = () => isPending(result()) && props.pendingPermissions?.some(p => p.id === toolCall.id);
						const startsStep = () => stepped() && i() > 0 && stepOf(calls()[i() - 1]!) !== stepOf(toolCall);
						return (<>
							<Show when={startsStep()}>
								<div class='toolStepDivider'><span>step {stepOf(toolCall)}</span></div>
							</Show>
							<div class='tool'>
								<ToolArgsView call={toolCall} result={result()} />
								<Show when={isPending(result()) && !permissionPending()}>
									<MatrixLoader />
									<Show when={toolCall.function.name === 'spawn_agent' ? runningAgentsByCallId().get(toolCall.id) : undefined}>
										{agent => <div class='agentProgress'>agent working — {agent().session.messages.length} messages</div>}
									</Show>
								</Show>
								<Show when={permissionPending() && props.resolvePermission}>
									{(() => {
										const pending = () => props.pendingPermissions?.find(p => p.id === toolCall.id);
										return <div class='permissionActions'>
											<Show when={pending()?.outside}>
												<span class='permissionOutsideLabel'>outside folder</span>
											</Show>
											<button class='permissionBtn permissionAllow' onClick={() => props.resolvePermission!(toolCall.id, true)}>Allow</button>
											<button class='permissionBtn permissionDeny' onClick={() => props.resolvePermission!(toolCall.id, false)}>Deny</button>
											<button class='permissionBtn permissionChat' onClick={() => props.resolvePermission!(toolCall.id, true, 'chat')}>Allow (chat)</button>
										</div>;
									})()}
								</Show>
								<Show when={!isPending(result())}>
									<Show when={props.editing()} fallback={
										<ToolResultView result={result()!} />
									}>
										{/* Editing writes `content`, which from then on overrides the tool's data. */}
										<textarea
											class='messageEdit toolResultEdit'
											value={resolveContent(result()!)}
											onClick={e => e.stopPropagation()}
											onInput={e => {
												const vi = props.currentVersionIndex();
												const idx = props.toolResults.findIndex(r => r.tool_call_id === toolCall.id);
												if (idx !== undefined && idx >= 0) {
													props.setMessages(props.messageIndex, 'tool_results', vi, idx, 'content', (e.target as HTMLTextAreaElement).value);
													props.setMessages(props.messageIndex, 'timing', prev => {
														const arr = prev ? prev.slice() : [];
														arr[vi] = { ...arr[vi], editedAt: Date.now() };
														return arr;
													});
												}
											}}
										/>
									</Show>
								</Show>
							</div>
						</>);
					}}
				</For>
			</Show>
		</div>
	);
}

function msgClean(msgContent: string): string {
	let newContent = msgContent.replace(/^[ \t]+/, '');
	// Remove asterisks immediately inside or outside quotations
	newContent = newContent.replace(/\**(["“])\**([^"”]*?)\**(["”])\**/g, '$1$2$3');

	return newContent
}

function starScrubber(content: string): string {
	return content.replace(/\*/g, '');
}

// Simple placeholder component for virtualized messages
export function MessagePlaceholder(props: { message: ChatMessage }) {
	return getMessageContent(props.message);
}

interface MessageListProps {
	messages: ChatMessage[];
	setMessages: SetStoreFunction<ChatMessage[]>;
	deleteMessage: (index: number) => void;
	sendMessage: (redo: number) => Promise<StreamingResult | undefined>;
	cut: number;
	setCut: Setter<number>;
	containerRef: HTMLDivElement;
	imageFolderFiles: Map<string, FileSystemFileHandle>;
	activeStreams: Map<ChatMessage, { controller: AbortController; versionIndex: number }[]>;
	providers: Record<Provider, ProviderConfig>;
	pendingPermissions?: Array<{ id: string; toolCall: any; resolve: (result: true | string) => void; outside?: boolean }>;
	resolvePermission?: ((id: string, approved: boolean, mode?: ToolApprove) => void) | undefined;
	chatFolder?: string;
	forkChat?: ((index: number) => void) | undefined;
	/** Message index to flash after a search/cut jump; -1 for none. */
	highlight?: number;
}

export function MessageList(props: MessageListProps) {
	setLinkCwd(() => props.chatFolder);
	return (
		<For each={props.messages}>
			{(msg, i) => {
				let bubbleRef!: HTMLDivElement;
				return (
					<div
						ref={el => bubbleRef = el}
						data-message-index={i()}
						class='messageBubble'
						classList={{
							['userMessage']: msg.role === 'user',
							['assistantMessage']: msg.role === 'assistant',
							['toolMessage']: msg.role === 'tool',
							['cutoffMessage']: i() === props.cut,
							['searchHighlight']: i() === props.highlight
						}}
					>
						<Show when={i() === 0 || props.cut === -1 || i() >= props.cut || props.cut >= props.messages.length} fallback={
							<div class='messagePlaceholder'>
								<MessagePlaceholder message={msg} />
								<button class='placeholderCutButton' onClick={() => props.setCut(i())}>
									<Icon name="arrow-bar-down" size={14} />
								</button>
							</div>
						}>
							<Message
								message={msg}
								index={i()}
								sendMessage={props.sendMessage}
								setMessages={props.setMessages}
								deleteMessage={props.deleteMessage}
								cut={props.cut}
								setCut={props.setCut}
								imageFolderFiles={props.imageFolderFiles}
								containerRef={bubbleRef}
								activeStreams={props.activeStreams}
								providers={props.providers}
								pendingPermissions={props.pendingPermissions}
								resolvePermission={props.resolvePermission}
								forkChat={props.forkChat}
							/>
						</Show>
					</div>
				);
			}}
		</For>
	);
}
