import { createSignal, createEffect, Show, For, batch, onCleanup, onMount, untrack, type Setter } from 'solid-js';
import { MInput } from './input';
import { MessageList, Icon } from './Message';
import { TopBar } from './TopBar';
import { SearchBar } from './SearchBar';
import { messageSearchHighlightRanges } from './helpers/searchHighlight';
import type { MessageWindowController } from './helpers/MessageWindow';
import { backendFor } from './helpers/backend';
import { undockWidget } from './helpers/widgets';
import { toolModeOf } from './helpers/types';
import type { ChatMessage, ChatMeta, Prompt, Provider, ProviderConfig } from './helpers/types';
import type { ChatViewController, LiveChat } from './helpers/liveChat';
import type { LoreEntry } from './helpers/lore';
import type { STCard } from './helpers/stImport';

export const focusInput = () => document.querySelector<HTMLTextAreaElement>('.inputField')?.focus();

interface ChatViewProps {
	/** Fixed for the view's lifetime: App mounts a new view for another chat. */
	live: LiveChat;
	prompts: Prompt[];
	lore: LoreEntry[];
	providers: Record<Provider, ProviderConfig>;
	sidebarOpen: boolean;
	setSidebarOpen: Setter<boolean>;
	error: string | null;
	setError: Setter<string | null>;
	info: string | null;
	setInfo: Setter<string | null>;
	onReload: () => void;
	/** Loads imported messages, into a new chat when this one isn't empty (desktop). */
	importChat: (messages: ChatMessage[], meta?: Partial<ChatMeta>) => Promise<boolean>;
	/** Adds a character card as a config (and lore), and opens its greeting as a chat. */
	importCard: (card: STCard) => Promise<void>;
	forkChat?: ((index: number) => void) | undefined;
}

// Short one-line summary of a tool call's args for the sub-agent permission card
function permSummary(toolCall: any): string {
	const args = toolCall.function?.arguments;
	if (!args) return '';
	const obj = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return { _: args }; } })() : args;
	const first = obj.path ?? obj.command ?? obj.url ?? Object.values(obj)[0];
	return String(first ?? '').replace(/\s+/g, ' ').slice(0, 120);
}

/** One chat on screen: top bar and search, message list, permission prompts, input. */
export function ChatView(props: ChatViewProps) {
	const { id: chatId, chat, setChat, session, config, promptMessages, pendingPermissions, resolvePermission, getChatMeta, applyChatMeta } = props.live;
	const { messages, setMessages, sendMessage, rerunToolCall, sendAsideMessage, sendRewriteMessage, compactNow, deleteMessage, abortAllStreams, isLoading, toolsRunning, queuedSend, queueSend, activeStreams, chatConflict } = session;

	const [streamPad, setStreamPad] = createSignal(false);
	const [copiedBox, setCopiedBox] = createSignal<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	function copyText(text: string, box: string) {
		navigator.clipboard.writeText(text).then(() => {
			setCopiedBox(box);
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => setCopiedBox(null), 1200);
		});
	}
	onCleanup(() => clearTimeout(copyTimer));
	// The side panel belongs to the chat that opened it
	onCleanup(undockWidget);

	//#  Scroll follow
	let msgs!: HTMLDivElement;
	let followingStream = false;
	let followAnchor = 0;
	let lastScrollTop = 0;
	let lastScrollHeight = 0;
	let leftFollowZone = false;
	let followCheck: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(followCheck));

	function scrollMessagesToBottom() {
		requestAnimationFrame(() => {
			if (!msgs) return;
			const padding = parseFloat(getComputedStyle(msgs).paddingBottom);
			msgs.scrollTop = Math.max(0, msgs.scrollHeight - msgs.clientHeight - padding);
		});
	}

	function onMessagesLoaded() {
		setStreamPad(false);
		scrollMessagesToBottom();
	}

	// Jump to bottom when content outgrows the padding space. Trailing-throttled:
	// tool output arrives line-by-line and every check forces a layout.
	function afterAppend() {
		if (!followingStream || followCheck) return;
		followCheck = setTimeout(() => {
			followCheck = undefined;
			if (!followingStream) return;
			const offscreen = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
			const paddingPx = parseFloat(getComputedStyle(msgs).paddingBottom);
			if (offscreen > paddingPx)
				msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
		}, 80);
	}

	// Marks a just-sent message so its bubble animates in. Set *before* the store
	// append: the class has to be on the element at its first paint, or the bubble
	// shows up plain for a frame and then snaps back to animate.
	const [justSent, setJustSent] = createSignal(-1);
	let sentTimer: ReturnType<typeof setTimeout> | undefined;
	function markSent(index: number) {
		clearTimeout(sentTimer);
		setJustSent(index);
		sentTimer = setTimeout(() => setJustSent(-1), 1700);
		scrollMessagesToBottom();
	}
	onCleanup(() => clearTimeout(sentTimer));

	//#  Search
	const [searchOpen, setSearchOpen] = createSignal(false);
	const [searchQuery, setSearchQuery] = createSignal('');
	const [searchActive, setSearchActive] = createSignal(-1);
	const [searchAllVersions, setSearchAllVersions] = createSignal(false);
	const [highlightIdx, setHighlightIdx] = createSignal(-1);
	let highlightTimer: ReturnType<typeof setTimeout> | undefined;
	let messageWindow: MessageWindowController | undefined;

	/**
	 * Scroll a message into view by array index, with a brief highlight.
	 * Mount the target window before positioning search, cut-point, and cross-chat jumps.
	 */
	function scrollToMessage(idx: number, flashMessage: boolean | 'search' = true) {
		if (idx < 0 || idx >= messages.length) return;
		messageWindow?.jump(idx);
		if (flashMessage === 'search') {
			const bubble = msgs.querySelector<HTMLElement>(`[data-message-index="${idx}"]`);
			flashMessage = typeof Highlight === 'undefined' || !CSS.highlights || !bubble
				|| !messageSearchHighlightRanges(bubble, messages[idx], searchQuery()).length;
		}
		if (!flashMessage) return;
		clearTimeout(highlightTimer);
		setHighlightIdx(idx);
		// Must outlast the CSS fade (search-flash) or the class drops mid-animation
		highlightTimer = setTimeout(() => setHighlightIdx(-1), 1900);
	}
	onCleanup(() => clearTimeout(highlightTimer));

	/** Animate the search icon between its button and the search bar, where supported. */
	function withIconMorph(update: () => void) {
		const start = (document as any).startViewTransition?.bind(document);
		if (start) start(update);
		else update();
	}

	function openSearch() {
		withIconMorph(() => setSearchOpen(true));
	}

	function closeSearch() {
		withIconMorph(() => batch(() => {
			setSearchOpen(false);
			setSearchActive(-1);
			setSearchAllVersions(false); // scope is per-session, never remembered
			setHighlightIdx(-1);
		}));
	}

	const controller: ChatViewController = { onMessagesLoaded, onUserAppend: markSent, afterAppend, scrollToMessage: idx => scrollToMessage(idx) };
	props.live.view = controller;
	onCleanup(() => { if (props.live.view === controller) props.live.view = undefined; });
	// The messages were loaded before this view existed
	onMount(onMessagesLoaded);

	createEffect(() => {
		if (props.error) {
			setTimeout(() => {
				msgs.scrollTop = msgs.scrollHeight;
				msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
			}, 100);
		}
	});

	// Arm streaming padding + auto-follow when a stream starts on the last message.
	// Keyed off stream starts rather than isLoading edges: isLoading dips for a microtask
	// between a stream ending and its tool calls starting, so an edge-triggered re-arm
	// lands with no active stream and would kill follow for the rest of a tool loop.
	createEffect(() => {
		const streams = activeStreams();
		untrack(() => {
			if (!streams.size) return;
			const last = messages[messages.length - 1];
			// Mid-list redo: never chase the bottom, and the padding has nothing to serve
			if (!last || !streams.has(last)) { followingStream = false; setStreamPad(false); return; }
			// Already armed — keep the user's follow choice across the whole tool loop
			if (streamPad()) return;
			setStreamPad(true);
			const offscreen = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
			const paddingPx = parseFloat(getComputedStyle(msgs).paddingBottom);
			followingStream = offscreen - paddingPx < 100;
			followAnchor = lastScrollTop = msgs.scrollTop;
			lastScrollHeight = msgs.scrollHeight;
			leftFollowZone = false;
			if (followingStream) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
		});
	});

	// Auto-follow tracks scroll position at all times (streaming or not), so a run that
	// starts while the padding is still up inherits a correct choice.
	// After streaming: silently remove padding once user scrolls it offscreen
	onMount(() => {
		let ignoreScroll = false;
		function stopFollow() {
			followingStream = false;
			msgs.scrollTo({ top: msgs.scrollTop, behavior: 'instant' });
		}
		msgs.addEventListener('wheel', (event) => {
			if (event.deltaY < -2 && followingStream) stopFollow();
			else if (event.deltaY > 0 && !followingStream) {
				const paddingPx = parseFloat(getComputedStyle(msgs).paddingBottom);
				if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight - paddingPx < 100) {
					followingStream = true;
					followAnchor = msgs.scrollTop;
					leftFollowZone = false;
				}
			}
		}, { passive: true });
		msgs.addEventListener('scroll', () => {
			if (ignoreScroll) return;
			const offscreen = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
			const paddingPx = parseFloat(getComputedStyle(msgs).paddingBottom);
			const distance = offscreen - paddingPx;
			if (msgs.scrollHeight < lastScrollHeight)
				followAnchor = Math.min(followAnchor, msgs.scrollTop);
			if (followingStream && msgs.scrollTop < followAnchor - 10) {
				stopFollow();
			} else if (!followingStream && leftFollowZone && msgs.scrollTop > lastScrollTop && distance < 100) {
				followingStream = true;
				followAnchor = msgs.scrollTop;
				leftFollowZone = false;
			}
			if (followingStream) followAnchor = Math.max(followAnchor, msgs.scrollTop);
			else if (distance >= 100) leftFollowZone = true;
			lastScrollTop = msgs.scrollTop;
			lastScrollHeight = msgs.scrollHeight;

			if (isLoading() || !streamPad()) return;
			if (msgs.scrollTop + msgs.clientHeight < msgs.scrollHeight - paddingPx) {
				ignoreScroll = true;
				setStreamPad(false);
				requestAnimationFrame(() => { ignoreScroll = false; });
			}
		});
	});

	onMount(() => {
		// Alt+Up/Down: previous/next message to the top of the list
		const handleMessageScroll = (e: KeyboardEvent) => {
			const isUp = e.key === 'ArrowUp' && e.altKey;
			const isDown = e.key === 'ArrowDown' && e.altKey;

			if (!isUp && !isDown) return;
			e.preventDefault();

			const messageElements = Array.from(msgs.querySelectorAll('.messageBubble'));
			if (messageElements.length < 3) return;

			const containerRect = msgs.getBoundingClientRect();
			const topY = containerRect.top;

			let closestIndex = 0;
			let closestDistance = Infinity;

			messageElements.forEach((el, idx) => {
				const rect = el.getBoundingClientRect();
				const elementTopY = rect.top;
				const distance = Math.abs(elementTopY - topY);
				if (distance < closestDistance) {
					closestDistance = distance;
					closestIndex = idx;
				}
			});

			const targetIndex = isUp ? closestIndex - 1 : closestIndex + 1;
			if (targetIndex >= 0 && targetIndex < messageElements.length) {
				(messageElements[targetIndex] as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			// Auto-focus input on plain typing when nothing else is focused
			if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
				const ae = document.activeElement as HTMLElement | null;
				const tag = ae?.tagName;
				if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !ae?.isContentEditable) {
					focusInput();
					// don't preventDefault so the char isn't swallowed
					return;
				}
			}

			if (!e.ctrlKey) return;

			if (e.key.toLowerCase() === 'f' && e.shiftKey) {
				e.preventDefault();
				if (searchOpen()) {
					// Already open — Ctrl+F again just reselects the query
					const input = document.querySelector('.searchInput') as HTMLInputElement | null;
					input?.select();
					input?.focus();
				} else openSearch();
			} else if (e.key === 'g' && chat.cut >= 0 && chat.cut < messages.length) {
				e.preventDefault();
				scrollToMessage(chat.cut, false);
			}
		};

		window.addEventListener('keydown', handleMessageScroll);
		document.addEventListener('keydown', handleKeyDown);
		onCleanup(() => {
			window.removeEventListener('keydown', handleMessageScroll);
			document.removeEventListener('keydown', handleKeyDown);
		});
	});

	const ownPermissions = () => pendingPermissions().filter(p => !p.chatName);
	const agentPermissions = () => pendingPermissions().filter(p => p.chatName);

	return (
		<div class='chatContainer'>
			<TopBar chat={chat} setChat={setChat} chatId={chatId} setMessages={setMessages} messages={messages} setError={props.setError} setInfo={props.setInfo} providers={props.providers} sidebarOpen={props.sidebarOpen} setSidebarOpen={props.setSidebarOpen} getChatMeta={getChatMeta} applyChatMeta={applyChatMeta} importChat={props.importChat} importCard={props.importCard} onOpenSearch={openSearch} onMessagesLoaded={onMessagesLoaded} searchOpen={searchOpen()}>
				<Show when={searchOpen()}>
					<SearchBar
						messages={messages}
						query={searchQuery()} setQuery={setSearchQuery}
						active={searchActive()} setActive={setSearchActive}
						allVersions={searchAllVersions()} setAllVersions={setSearchAllVersions}
						onJump={idx => scrollToMessage(idx, 'search')}
						onClose={closeSearch}
					/>
				</Show>
			</TopBar>

			<div class={`messageList ${streamPad() ? 'streaming' : ''}`} ref={msgs}>
				<MessageList windowController={controller => messageWindow = controller} messages={messages} prompts={promptMessages()} sendMessage={sendMessage} rerunToolCall={rerunToolCall} setMessages={setMessages} deleteMessage={deleteMessage} chat={chat} setChat={setChat} containerRef={msgs} activeStreams={activeStreams()} providers={props.providers} pendingPermissions={pendingPermissions()} resolvePermission={resolvePermission} forkChat={props.forkChat} highlight={highlightIdx()} searchQuery={searchOpen() ? searchQuery() : ''} justSent={justSent()} />
				<Show when={messages.length <= 1}>
					<p class='emptyState'>Start chatting by typing below...</p>
				</Show>
				<Show when={chatConflict()}>
					<div class='messageBubble errorMessage'>
						<p class='messageContent'>This chat changed in another window. Reload to load the latest version — unsaved changes here will be lost.</p>
						<button onClick={props.onReload}>Reload chat</button>
					</div>
				</Show>
				<Show when={props.error}>
					<div class='messageBubble errorMessage'>
						<p class='messageContent'>{props.error}</p>
						<span class='infoBoxActions'>
							<button class='mbutton' title='Copy' onClick={() => copyText(props.error!, 'error')}>
								<Show when={copiedBox() === 'error'} fallback={<Icon name="clipboard" size={16} />}>
									<Icon name="check" size={16} />
								</Show>
							</button>
							<button class='mbutton' title='Dismiss' onClick={() => props.setError(null)}><Icon name="x" size={16} /></button>
						</span>
					</div>
				</Show>
				<Show when={props.info}>
					<div class='messageBubble infoMessage'>
						<p class='messageContent'>{props.info}</p>
						<span class='infoBoxActions'>
							<button class='mbutton' title='Copy' onClick={() => copyText(props.info!, 'info')}>
								<Show when={copiedBox() === 'info'} fallback={<Icon name="clipboard" size={16} />}>
									<Icon name="check" size={16} />
								</Show>
							</button>
							<button class='mbutton' title='Dismiss' onClick={() => props.setInfo(null)}><Icon name="x" size={16} /></button>
						</span>
					</div>
				</Show>
			</div>
			<Show when={ownPermissions().length}>
				<button class='pendingPermissionBadge' onClick={() => {
					const ids = new Set(ownPermissions().map(p => p.id));
					// run_js nested calls ask as `${outerId}:${n}`
					const index = messages.findIndex(msg => msg.tool_calls?.[msg.currentVersionIndex || 0]?.some(tc => ids.has(tc.id) || [...ids].some(id => id.startsWith(tc.id + ':'))));
					if (index >= 0) scrollToMessage(index);
				}}>
					{ownPermissions().length} edit{ownPermissions().length > 1 ? 's' : ''} pending approval
				</button>
			</Show>

			{/* Sub-agent permission requests: rendered as standalone cards since the
			     agent's tool call isn't in the visible message list */}
			<Show when={agentPermissions().length}>
				<div class='agentPermissionStack'>
					<For each={agentPermissions()}>
					{p => (
						<div class='agentPermissionCard'>
							<div class='agentPermissionHead'>
								<span class='agentPermissionChat'>{p.chatName}</span>
								<Show when={p.outside}><span class='permissionOutsideLabel'>outside folder</span></Show>
							</div>
							<div class='agentPermissionTool'>
								<span class='agentPermissionToolName'>{p.toolCall.function?.name}</span>
								<span class='agentPermissionToolArgs'>{permSummary(p.toolCall)}</span>
							</div>
							<div class='permissionActions'>
								<button class='permissionBtn permissionAllow' onClick={() => resolvePermission(p.id, true)}>Allow</button>
								<button class='permissionBtn permissionDeny' onClick={() => resolvePermission(p.id, false)}>Deny</button>
								<button class='permissionBtn permissionChat' onClick={() => resolvePermission(p.id, true, 'chat')}>Allow (chat)</button>
							</div>
						</div>
					)}
					</For>
				</div>
			</Show>

			<MInput
				chat={chat} setChat={setChat}
				isLoading={isLoading()} toolsRunning={toolsRunning()} queuedSend={queuedSend()} queueSend={queueSend} sendMessage={sendMessage} sendAsideMessage={sendAsideMessage} sendRewriteMessage={sendRewriteMessage} compactChat={compactNow}
				abortAllStreams={abortAllStreams}
				setMessages={setMessages} messages={messages} onUserAppend={markSent}
				prompts={props.prompts}
				lore={props.lore}
				chatId={chatId}
				backend={backendFor(chat.backend)}
				tools={config()?.tools}
				toolMode={toolModeOf(config())}
				preserveReasoning={config()?.preserveReasoning}
				setError={props.setError}
			/>
		</div>
	);
}
