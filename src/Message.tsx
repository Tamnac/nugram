import { createSignal, Show, createEffect, createRenderEffect, createMemo, onCleanup, For, batch, createRoot, untrack, type JSX } from 'solid-js';
import { SetStoreFunction } from 'solid-js/store'
import { Remarkable } from 'remarkable';
import type { ChatMessage, ToolApprove, ToolCall, ToolResult, ProviderConfig, Provider } from './helpers/types'
import { providerNames } from './helpers/types'
import type { ChatState } from './helpers/chatState'
import { getMessageContent, getMessageThinking, getMessageVersionCount, addMessageVersion, messageTps } from './helpers/messages'
import { handleLineClipboard, typeHelper, tabComplete } from './helpers/typing'
import { thinkingParser, handleLinkClick, setLinkCwd, enableSupSub, enableMath, enableSvg } from './helpers/markdown'
import { attachFromTransfer, loadTextFile } from './helpers/attachments'
import { ChatImage } from './helpers/Comps'
import { FileContent, type FileContentData } from './helpers/fileContent'
import { toolModules, resolveContent, isPending, executionSteps, stepOf, RUN_JS_TOOL } from './helpers/tools'
import { MatrixLoader, ToolArgsView, ToolResultView, ToolSummaryItem } from './helpers/ToolViews'
import { sanitize } from './helpers/sanitize'
import { patchHtml, type PatchOptions } from './helpers/patchHtml'
import { imageSource, resolveImageUrl } from './helpers/imageFolder'
import { runningAgentsByCallId } from './helpers/agent';
import { TbOutlineTrashX, TbOutlineRefresh, TbOutlinePencil, TbOutlineClipboard,
	TbOutlineChevronDown, TbOutlineChevronUp, TbOutlinePlus, TbOutlineSparkles,
	TbOutlineEraser, TbOutlineClock, TbOutlineCoins, TbOutlineSpeedboat,
	TbOutlineBrain, TbOutlineMessage, TbOutlinePlayerStop, TbOutlinePlayerPlay,
	TbOutlineArrowBarDown, TbOutlineGitFork, TbOutlineCopy, TbOutlineX, TbOutlineCheck } from 'solid-icons/tb'
import type { IconTypes } from 'solid-icons'
import type { StreamingResult } from './helpers/streaming'
import type { PromptMessage } from './helpers/buildRequest'
import type { ChatSession } from './helpers/session'
import { MessageWindow, type MessageWindowController } from './helpers/MessageWindow';
import { highlightSearchMatches } from './helpers/searchHighlight';
import { toolsMatch } from './helpers/search';
import { JsonField } from './helpers/JsonEditor';
import { widgetSlotHtml, mountWidgetSlots, widgetRegistry, dockedWidget } from './helpers/widgets';

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
	'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'select', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'
// iframe intentionally excluded
]);

const parser = new Remarkable({ html: true, typographer: false });
enableSupSub(parser);
enableMath(parser);
enableSvg(parser);
parser.block.ruler.disable(['code'])

// Renderer overrides — these only fire for tokens remarkable parsed as text/HTML,
// never for code block content (which goes through separate fence/code rules).

// Escape non-standard HTML tags (e.g. <Character>) so they render as text.
const defaultHtmltag = parser.renderer.rules.htmltag;
parser.renderer.rules.htmltag = function(tokens: any[], idx: number, options: any, env: any) {
	const content = tokens[idx].content;
	const m = content.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/);
	if (m && m[1].toLowerCase() === 'widget') {
		const slot = widgetSlotHtml(content);
		if (slot !== null) return slot;
	}
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
	spriteify(TbOutlinePlayerPlay, 'i-player-play');
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



function render(text: string): string {
	return sanitize(parser.render(text));
}

function renderThinking(text: string) {
	return thinkingParser.render(text);
}

/**
 * Keeps `el`'s content in step with `html()`. While `patch()` holds (streaming) the DOM is updated in
 * place, so what the user is pressing, selecting or reading is not rebuilt per chunk.
 */
function bindHtml(el: HTMLElement, html: () => string, patch: () => boolean, options?: PatchOptions) {
	createRenderEffect(() => {
		const next = html();
		if (untrack(patch)) patchHtml(el, next, options);
		else el.innerHTML = next;
	});
}

/** Image sources are resolved after rendering, so a re-rendered placeholder must not lose its `src`. */
const keepResolvedImage: NonNullable<PatchOptions['keep']> = (live, next) =>
	live.tagName === 'IMG' && live.getAttribute('data-local-src') === next.getAttribute('data-local-src');

async function processLocalImages(container: HTMLElement) {
	for (const img of container.querySelectorAll<HTMLImageElement>('img[data-local-src]')) {
		const ref = img.getAttribute('data-local-src');
		if (!ref) continue;

		const url = await resolveImageUrl(ref).catch(err => {
			console.warn('Failed to load local image:', ref, err);
			return null;
		});
		if (url) {
			img.src = url;
			img.style.opacity = '';
		} else {
			img.removeAttribute('src');
			img.alt = `${ref} not found in image folder`;
			img.style.opacity = '0.5';
		}
	}
}

/** Relative image sources become placeholders processLocalImages resolves against the image folder. */
function convertLocalImageRefs(html: string): string {
	const imageRegex = /<img[^>]+src="(?!https?:\/\/|data:|blob:)([^"]+\.(jpg|jpeg|png|gif|webp|bmp|svg))"[^>]*>/gi;

	return html.replace(imageRegex, (match, filename) => {
		const alt = match.match(/alt="([^"]*)"/)?.[1] ?? '';
		return `<img data-local-src="${filename}" alt="${alt}" style="max-width: 100%; height: auto;" loading="lazy" />`;
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
	setCut: (index: number) => void;
	rerunToolCall: ChatSession['rerunToolCall'];
	containerRef: HTMLDivElement;
	activeStreams: Map<ChatMessage, { controller: AbortController; versionIndex: number }[]>;
	providers: Record<Provider, ProviderConfig>;
	pendingPermissions?: Array<{ id: string; toolCall: any; resolve: (result: true | string) => void; outside?: boolean }> | undefined;
	resolvePermission?: ((id: string, approved: boolean, mode?: ToolApprove) => void) | undefined;
	forkChat?: ((index: number) => void) | undefined;
	searchQuery?: string | undefined;
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

	function postProcessContent() {
		if (!messageContentRef) return;
		requestAnimationFrame(async () => {
			addCopyButtonsToCodeBlocks(messageContentRef);
			await processLocalImages(messageContentRef);
		});
	}

	// Re-run when content changes (streaming, version switch), editing ends, or image folder changes
	createEffect(() => {
		const content = getMessageContent(props.message);
		imageSource();

		if (messageContentRef && !editing() && content) {
			postProcessContent();
		}
	});

	// This message's own streaming state. Reading the streams map directly would re-run the effect
	// below — reloading the iframes — whenever any other message started or stopped streaming.
	const widgetStreaming = createMemo(() => {
		const vi = props.message.currentVersionIndex || 0;
		return !!props.activeStreams.get(props.message)?.some(e => e.versionIndex === vi);
	});

	// Widgets mount once the stream ends (re-rendering per chunk would reload the iframes) and after each rescan
	createEffect(() => {
		if (!/<widget\b/i.test(getMessageContent(props.message))) return;
		widgetRegistry();
		dockedWidget();
		if (editing() || widgetStreaming()) return;
		requestAnimationFrame(() => messageContentRef && mountWidgetSlots(messageContentRef));
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
		const resize = () => {
			let h = 0;
			for (const child of bubble.children) {
				const el = child as HTMLElement;
				const style = getComputedStyle(el);
				h += el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
			}
			
			if (h !== lastH) {
				lastH = h;
				bubble.style.height = h + 'px';
			}
		};
		const ro = new ResizeObserver(resize);
		for (const child of bubble.children) ro.observe(child);
		const mo = new MutationObserver(records => {
			for (const record of records) {
				for (const node of record.removedNodes) if (node instanceof Element) ro.unobserve(node);
				for (const node of record.addedNodes) if (node instanceof Element) ro.observe(node);
			}
			resize();
		});
		mo.observe(bubble, { childList: true });

		onCleanup(() => {
			mo.disconnect();
			ro.disconnect();
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
				<span class='versionPicker'>
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
								<span>Tokens: {usage()?.message_tokens}{usage()?.reasoning_tokens ? ` | ${usage()?.reasoning_tokens}` : ''}</span>
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
								<span>TPS: {formatTps(messageTps(props.message))} t/s</span>
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
					<VersionPicker />

					<span class='messageInfo'>{props.index}</span>
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

	/** Assistant tool call with no text: the tool preview row hosts the header controls. */
	const combined = () => props.message.role === 'assistant'
		&& !!props.message.tool_calls?.[currentVersionIndex()]?.length
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
					<summary class='messageThinkLabel' ref={el => bindHtml(el,
						() => renderPreview(getLastLine(getMessageThinking(props.message) || '')), isCurrentVersionStreaming)}></summary>
					<Show when={thinkEx().expanded}>
						<div ref={el => bindHtml(el, () => renderThinking(getMessageThinking(props.message) || ''), isCurrentVersionStreaming)}
							class='messageThinkContent' onClick={handleLinkClick} />
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
						{(id, i) => <ChatImage src={id} label={(images()?.length ?? 0) > 1 ? `Image ${i() + 1}` : undefined} onRemove={editing() ? () => updateImages(prev => prev.filter((_, j) => j !== i())) : undefined} />}
					</For>
				</div>
			</Show>
			<Show when={!editing() && props.message.tool_calls?.[currentVersionIndex()]?.length}>
				<ToolInlineViews toolCalls={props.message.tool_calls![currentVersionIndex()]} toolResults={props.message.tool_results?.[currentVersionIndex()] || []} />
			</Show>
			<Show when={editing()} fallback={
				<div ref={el => {
					messageContentRef = el;
					// Mounted widgets are moved and filled by mountWidgetSlots, which a position-based patch would undo
					bindHtml(el, () => convertLocalImageRefs(render(getMessageContent(props.message))),
						() => isCurrentVersionStreaming() && !el.querySelector('.widgetFrame'),
						{ prepare: addCopyButtonsToCodeBlocks, keep: keepResolvedImage });
				}} class='messageContent' onClick={handleLinkClick} />
			}>
				<Show when={props.message.role !== 'user' && getMessageThinking(props.message)}>
					<textarea class='messageEdit messageEditContained messageThinkEdit'
						ref={el => requestAnimationFrame(() => { el.style.height = Math.min(el.scrollHeight, 300) + 'px'; })}
						value={getMessageThinking(props.message) || ''}
						onInput={e => editText(e, 'thinking')}
						onkeydown={finishEdit}
						onCopy={handleLineClipboard} onCut={handleLineClipboard} data-field="thinking" />
				</Show>
				<textarea class='messageEdit messageEditContained'
					ref={el => { msgBox = el; requestAnimationFrame(() => { el.style.height = el.scrollHeight + 'px'; }); }}
					value={getMessageContent(props.message)} onInput={editText} onkeydown={finishEdit} onPaste={pasteImages}
					onCopy={handleLineClipboard} onCut={handleLineClipboard} data-field="content" />
			</Show>
			<Show when={props.message.tool_calls?.[currentVersionIndex()]?.length}>
				<ToolCalls
					toolCalls={props.message.tool_calls![currentVersionIndex()]}
					toolResults={props.message.tool_results?.[currentVersionIndex()] || []}
					pendingPermissions={props.pendingPermissions}
					resolvePermission={props.resolvePermission}
					searchHit={toolsMatch(props.message, props.searchQuery || '')}
					editing={editing}
					currentVersionIndex={currentVersionIndex}
					setMessages={props.setMessages}
					messageIndex={props.index}
					rerun={(callId, args) => {
						touchEdited(currentVersionIndex());
						return props.rerunToolCall(props.message, props.index, currentVersionIndex(), callId, args);
					}}
					header={combined() ? <><VersionPicker /><HeaderButtons /></> : undefined}
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
	/** The search query matches this block's calls or results, so it opens to show them. */
	searchHit: boolean;
	editing: () => boolean;
	currentVersionIndex: () => number;
	setMessages: SetStoreFunction<ChatMessage[]>;
	messageIndex: number;
	/** Runs a call of a `rerunnable` tool again with edited arguments. */
	rerun: (callId: string, args: {}) => Promise<void>;
	/** Message header controls, hosted in the preview row when the message has no text. */
	header?: JSX.Element;
	/** Message info menu, shown under the preview row when the header is hosted here. */
	menu?: JSX.Element;
}

function ToolCalls(props: ToolCallsArgs) {
	const [toolsEx, setToolsEx] = createSignal(false);

	// One preview row per step, in execution order; a flat turn is a single row.
	const steps = createMemo(() => executionSteps(props.toolCalls || []));
	const calls = createMemo(() => steps().flat());
	// Index in calls() where each later step begins, for the expanded dividers.
	const stepStarts = createMemo(() => {
		const starts = new Set<number>();
		let n = 0;
		for (const step of steps()) { if (n > 0) starts.add(n); n += step.length; }
		return starts;
	});

	const hasPending = () => props.pendingPermissions?.length &&
		props.toolCalls.some(tc => props.pendingPermissions?.some(p => permissionOf(p.id, tc.id)));
	// Auto-expand when permission is pending
	createEffect(() => { if (hasPending()) setToolsEx(true); });
	createEffect(() => { if (props.searchHit) setToolsEx(true); });

	// Click anywhere in the block toggles, except interactive areas and text selections.
	const toggle = (e: MouseEvent) => {
		const el = e.target as HTMLElement;
		if (el.closest('.permissionActions, .toolHeaderButtons, .toolMenu, .jsCall')) return;
		const sel = window.getSelection();
		if (sel && sel.toString().length > 0) return;
		setToolsEx(p => !p);
	};

	return (<>
		<div class='toolCallContainer' onclick={toggle}>
			<div class='toolHeader'>
				<span class='toolChips'>
				<For each={steps()}>
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
						// The call's own request, or one from a call it makes (run_js).
						const pending = () => props.pendingPermissions?.find(p => p.id === toolCall.id ? isPending(result()) : permissionOf(p.id, toolCall.id));
						const permissionPending = () => pending()?.id === toolCall.id;
						return (<>
							<Show when={stepStarts().has(i())}>
								<div class='toolStepDivider'><span>step {stepOf(toolCall)}</span></div>
							</Show>
							<div class='tool'>
								<ToolArgsView call={toolCall} result={result()} />
								<Show when={props.editing() && toolCall.parent === undefined && toolModules[toolCall.function.name]?.rerunnable}>
									<ToolArgsEdit call={toolCall} busy={isPending(result())} rerun={args => props.rerun(toolCall.id, args)} />
								</Show>
								<Show when={isPending(result()) && !permissionPending()}>
									<MatrixLoader />
									<Show when={toolCall.function.name === 'spawn_agent' ? runningAgentsByCallId().get(toolCall.id) : undefined}>
										{agent => <div class='agentProgress'>agent working — {agent().session.messages.length} messages</div>}
									</Show>
								</Show>
								<Show when={props.resolvePermission && pending()}>
									{p => <div class='permissionActions'>
										<Show when={p().id !== toolCall.id}>
											<ToolSummaryItem toolCall={p().toolCall} />
										</Show>
										<Show when={p().outside}>
											<span class='permissionOutsideLabel'>outside folder</span>
										</Show>
										<button class='permissionBtn permissionAllow' onClick={() => props.resolvePermission!(p().id, true)}>Allow</button>
										<button class='permissionBtn permissionDeny' onClick={() => props.resolvePermission!(p().id, false)}>Deny</button>
										<button class='permissionBtn permissionChat' onClick={() => props.resolvePermission!(p().id, true, 'chat')}>Allow (chat)</button>
									</div>}
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
	</>);
}

/** JSON editor for a call's arguments; "Run again" executes the tool with them and replaces the result. */
function ToolArgsEdit(props: { call: ToolCall; busy: boolean; rerun: (args: {}) => void }) {
	const [text, setText] = createSignal(JSON.stringify(props.call.function.arguments, null, 2));
	const parsed = createMemo((): { args?: {}; error?: string } => {
		try {
			const value = JSON.parse(text());
			return value && typeof value === 'object' && !Array.isArray(value) ? { args: value } : { error: 'Arguments must be a JSON object' };
		} catch (e: any) {
			return { error: e.message };
		}
	});
	return (
		<div class='toolArgsEdit' onClick={e => e.stopPropagation()}>
			<JsonField text={text()} onChange={setText} schema={toolModules[props.call.function.name]?.definition.function.parameters} textClass='messageEdit toolResultEdit' />
			<button class='mbutton' title='Run again' disabled={!parsed().args || props.busy} onClick={() => props.rerun(parsed().args!)}>
				<Icon name='player-play' size={17} />
			</button>
			<Show when={parsed().error}>{error => <span class='toolArgsError'>{error()}</span>}</Show>
		</div>
	);
}

/**
 * What tools show in the message itself (widgets). Rendered ahead of the message text, which is
 * what lets css/messages.css float one beside the text; without that layout it is ordered to the
 * end of the bubble, after the tool rows.
 */
function ToolInlineViews(props: { toolCalls: ToolCall[]; toolResults: ToolResult[] }) {
	type Entry = { name: string; result?: ToolResult | undefined };
	// Calls a run_js snippet made are logged in its result, and show like top-level ones.
	const entries = createMemo(() => {
		const byId = new Map<string, Entry>();
		for (const call of executionSteps(props.toolCalls).flat()) {
			const result = props.toolResults.find(r => r.tool_call_id === call.id);
			byId.set(call.id, { name: call.function.name, result });
			if (call.function.name !== RUN_JS_TOOL || !Array.isArray(result?.data?.log)) continue;
			for (const entry of result.data.log as { call?: ToolCall; result?: ToolResult }[])
				if (entry.call) byId.set(entry.call.id, { name: entry.call.function.name, result: entry.result });
		}
		return byId;
	});
	const ids = createMemo(() => [...entries()].filter(([, e]) => toolModules[e.name]?.Inline).map(([id]) => id));
	return (
		<For each={ids()}>
			{id => {
				const Inline = toolModules[entries().get(id)!.name]!.Inline!;
				const data = () => {
					const result = entries().get(id)?.result;
					return result?.content === undefined && result?.data?.error === undefined ? result?.data : undefined;
				};
				return <Show when={data()}>{d => <Inline data={d()} />}</Show>;
			}}
		</For>
	);
}

/** Whether a permission request belongs to a call: its own, or one of its run_js nested calls (`${id}:${n}`). */
function permissionOf(requestId: string, callId: string): boolean {
	return requestId === callId || requestId.startsWith(callId + ':');
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

function PromptEntry(props: { prompt: PromptMessage }) {
	return (
		<details class='promptEntry'>
			<summary class='messageThinkLabel'>
				<span style='font-weight: bold; opacity: 0.7'>{names[props.prompt.role] || props.prompt.role}</span>
				<span style='margin: 0 0.2em 0 auto'>{props.prompt.name || 'Prompt'}</span></summary>
			<div class='promptEntryContent'>{props.prompt.content}</div>
		</details>
	);
}

interface MessageListProps {
	messages: ChatMessage[];
	windowController: (controller: MessageWindowController) => void;
	/** Request-time prompts shown in the flow at their insertion slot (see buildRequest). */
	prompts?: PromptMessage[];
	setMessages: SetStoreFunction<ChatMessage[]>;
	deleteMessage: (index: number) => void;
	sendMessage: (redo: number) => Promise<StreamingResult | undefined>;
	rerunToolCall: ChatSession['rerunToolCall'];
	chat: ChatState;
	setChat: SetStoreFunction<ChatState>;
	containerRef: HTMLDivElement;
	activeStreams: Map<ChatMessage, { controller: AbortController; versionIndex: number }[]>;
	providers: Record<Provider, ProviderConfig>;
	pendingPermissions?: Array<{ id: string; toolCall: any; resolve: (result: true | string) => void; outside?: boolean }>;
	resolvePermission?: ((id: string, approved: boolean, mode?: ToolApprove) => void) | undefined;
	forkChat?: ((index: number) => void) | undefined;
	/** Message index to flash after a jump; -1 for none. */
	highlight?: number;
	searchQuery?: string;
	/** Message index to animate in as just-sent; -1 for none. */
	justSent?: number;
}

export function MessageList(props: MessageListProps) {
	setLinkCwd(() => props.chat.chatFolder);
	const cut = () => props.chat.cut;
	const setCut = (index: number) => props.setChat('cut', index);
	createEffect(() => {
		onCleanup(highlightSearchMatches(props.containerRef, props.searchQuery || '', props.messages));
	});
	// Insertion slots over sent (post-cut) messages, mirroring buildRequest's anchor mapping
	const promptSlots = createMemo(() => {
		const start = cut() > 0 && cut() < props.messages.length ? cut() : 0;
		const len = props.messages.length - start;
		const slots: [number, PromptMessage[]][] = [];
		props.prompts?.forEach(p => {
			const li = p.position < 0 ? Math.max(0, len + p.position + 1) : Math.min(p.position, len);
			const ri = start + li;
			const slot = slots.find(s => s[0] === ri);
			if (slot) slot[1].push(p); else slots.push([ri, [p]]);
		});
		return slots;
	});
	return (
		<>
		<MessageWindow messages={props.messages} container={props.containerRef} controller={props.windowController} deferResizeUpdates={props.activeStreams.size > 0}>
		{(start, end) => <For each={props.messages.slice(start, end())}>
			{(msg, localIndex) => {
				const i = () => start + localIndex();
				let bubbleRef!: HTMLDivElement;
				return (
					<>
					<For each={promptSlots().find(s => s[0] === i())?.[1]}>
						{p => <PromptEntry prompt={p} />}
					</For>
					<div
						ref={el => bubbleRef = el}
						data-message-index={i()}
						class='messageBubble'
						classList={{
							['userMessage']: msg.role === 'user',
							['assistantMessage']: msg.role === 'assistant',
							['toolMessage']: msg.role === 'tool',
							['cutoffMessage']: i() === cut(),
							['searchHighlight']: i() === props.highlight,
							['justSent']: i() === props.justSent
						}}
					>
						<Show when={i() === 0 || cut() === -1 || i() >= cut() || cut() >= props.messages.length} // todo consider dropping message placeholders since we have windowing
								fallback={
									<div class='messagePlaceholder'>
										<MessagePlaceholder message={msg} />
										<button class='placeholderCutButton' onClick={() => setCut(i())}>
											<Icon name="arrow-bar-down" size={14} />
										</button>
									</div>
								}>
							<Message
								message={msg}
								index={i()}
								sendMessage={props.sendMessage}
								rerunToolCall={props.rerunToolCall}
								setMessages={props.setMessages}
								deleteMessage={props.deleteMessage}
								cut={cut()}
								setCut={setCut}
								containerRef={bubbleRef}
								activeStreams={props.activeStreams}
								providers={props.providers}
								pendingPermissions={props.pendingPermissions}
								resolvePermission={props.resolvePermission}
								forkChat={props.forkChat}
								searchQuery={props.searchQuery}
							/>
						</Show>
					</div>
					</>
				);
			}}
		</For>}
		</MessageWindow>
		<For each={promptSlots().find(s => s[0] === props.messages.length)?.[1]}>
			{p => <PromptEntry prompt={p} />}
		</For>
		</>
	);
}
