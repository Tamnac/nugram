import { createSignal, type Accessor, type Setter } from 'solid-js';
import { createStore, unwrap, type SetStoreFunction } from 'solid-js/store';
import { throttle, leadingAndTrailing } from '@solid-primitives/scheduled';

import { saveDirtyMessages, deleteMessageById, insertMessageAt } from './storage';
import { isTauri } from './platform';
import { streamChatCompletion, type StreamingResult } from './streaming';
import { getMessageContent, getMessageThinking, insertAtIndex, addMessageVersion, repairOrphanedToolCalls, latestJsState } from './messages';
import { buildRequestMessages, type PromptMessage } from './buildRequest';
import { inlineAttachments } from './attachments';
import { createTextDrip } from './textDrip';
import { reLore, msgVars } from './Extras';
import { loadPools } from './tools/pools';
import { applyToolCalls, expandRunCalls, runnableTools, sentTools, toolModules, wrapInRunJs } from './tools';
import type { ChatSnapshot, ToolContext } from './tools/types';
import { cancelJs, jsRuntimeKey } from './jsRuntime/host';
import { cutStart, planFold, sentMessages } from './folds';
import { formatWidgetMessage, usedWidgetIds } from './widgets';
import { estimateContextTokens, isAdequateSummary, COMPACT_LOOKBACK, type CompactSettings } from './compact';
import { expectedCachedTokens, preSendCheck, postResponseCheck, shouldNotifyMiss } from './cacheGuard';
import { resolveConfigOptions } from './PromptManager';
import type { Backend } from './backend';
import type { LoreEntry } from './lore';
import { isGpt56OrLater, toolModeOf } from './types';
import { providerLabel } from './modelCatalog';
import type { cacheType, cacheLength, Config, ChatMessage, FileAttachment, Fold, Provider, ProviderConfig, Options, Role, Message, ToolCall, ToolResult } from './types';

/** Snapshot of the input captured at queue time; sent once the current turn fully ends. */
export interface QueuedSend { content: string; images: string[]; files: FileAttachment[]; role: Role }

/** Limits for messages widgets send with `widgetSend`. */
const MAX_WIDGET_MESSAGE_CHARS = 20_000;
const MAX_QUEUED_WIDGET_MESSAGES = 20;

const SITE_NAME = 'Nugram';

/**
 * Everything a session needs from outside. Fields are accessors, so the visible
 * session reads App's current signal values on every call. Headless sessions
 * (sub-agents) pass functions that return values copied at spawn time.
 */
export interface SessionEnv {
	chatId: () => string;
	model: () => string;
	provider: () => Provider;
	providers: () => Record<Provider, ProviderConfig>;
	options: () => Options;
	activeConfig: () => Config | undefined;
	promptMessages: () => PromptMessage[]; // redundant with activeConfig?
	cache: () => cacheType;
	cacheLength: () => cacheLength;
	macros: () => Record<string, string>;
	chatFolder: () => string;
	cut: () => number;
	sendMode: () => 'loop' | 'single';
	/** Per-chat toggle: auto-compact context in loop mode. Off when absent (headless sessions). */
	autoCompact?: (() => boolean) | undefined;
	/** Global auto-compaction settings (token threshold + compaction prompt). */
	compactSettings?: (() => CompactSettings) | undefined;
	/** Moves the cut point after compaction. Auto-compaction is unavailable when absent. */
	setCut?: ((n: number) => void) | undefined;
	/** Folded spans (see helpers/folds.ts). None when absent. */
	folds?: (() => Fold[]) | undefined;
	/** The fold tool is unavailable when absent. */
	setFolds?: ((folds: Fold[]) => void) | undefined;
	/** Called when a message is inserted (delta = 1) or deleted (delta = -1) at `index`. Shifts the cut and fold indices so they still point to the same messages. */
	onSplice?: ((index: number, delta: 1 | -1) => void) | undefined;
	lore: LoreEntry[];
	setLore: SetStoreFunction<LoreEntry[]>;
	requestPermission: (toolCall: any, chatName?: string) => Promise<true | string>;
	/** Withdraws a pending permission prompt (resolving it as denied), e.g. when the run_js run that requested it has ended. */
	dismissPermission?: ((id: string) => void) | undefined;
	/** Where the shell and file tools do their work. */
	backend: () => Backend;
	setError: Setter<string | null>;
	setInfo: Setter<string | null>;
	/** Chat input; only the visible session has one. Headless sessions add their messages directly. */
	input?: {
		value: () => string; images: () => string[]; files: () => FileAttachment[]; role: () => Role;
		clear: () => void;
		/** Put a dropped queued message back into the input (abort, failed turn, unqueue). */
		restore?: ((q: QueuedSend) => void) | undefined;
	};
	/** Runs a spawn_agent tool call. The tool is unavailable when absent (web build, or a sub-agent). */
	spawnAgent?: ToolContext['spawnAgent'];
	/** A sub-agent's spawning chat, copied at spawn time. */
	parentChat?: ChatSnapshot | undefined;
	/** Called by abortAllStreams to cancel spawned sub-agents. */
	onAbort?: (() => void) | undefined;
	/** Streaming implementation override (tests). Defaults to streamChatCompletion. */
	stream?: typeof streamChatCompletion | undefined;
}

/** UI hooks — only the visible session provides these. */
export interface SessionUI {
	textDrip?: () => boolean;
	/** Called after freshly loaded messages replace the session state. */
	onMessagesLoaded?: () => void;
	/** Called after streamed content is appended (scroll-follow). */
	afterAppend?: () => void;
	/** Called just before a user message is appended, with the index it will take. */
	onUserAppend?: (index: number) => void;
	/** Called when a stream finishes successfully (notifications). */
	onStreamDone?: (content: string) => void;
}

export type ChatSession = ReturnType<typeof createChatSession>;

/**
 * Runs one chat: a message store that tracks changed indices for persistence,
 * serialized writes with optimistic concurrency, streaming, and the tool loop.
 * The visible chat has one session; each sub-agent has a headless one.
 * No reactive computations are created here, so sessions can be created outside
 * the component tree.
 */
export function createChatSession(env: SessionEnv, ui?: SessionUI) {
	// Key for this chat's shell state on the backend (previous output, cancellation)
	const shellSession = () => env.chatId() || 'main';
	/** What every tool run gets from this session; callers add their own selection, permissions and result handling. */
	const toolContext = (): ToolContext => ({
		lore: env.lore,
		setLore: env.setLore,
		chatFolder: env.chatFolder(),
		chatId: env.chatId(),
		shellSession: shellSession(),
		backend: env.backend(),
		model: env.model(),
		provider: env.provider(),
		spawnAgent: env.spawnAgent,
		requestPermission: tc => env.requestPermission(tc),
		usedWidgetIds: () => usedWidgetIds(unwrap(messages)),
	});
	const [messages, _setMessages] = createStore<ChatMessage[]>([]);
	const [activeStreams, setActiveStreams] = createSignal<Map<ChatMessage, { controller: AbortController; versionIndex: number }[]>>(new Map());
	// Count, not a flag: concurrent turns each run tools, and one finishing must not clear the other's state.
	const [toolsRunningCount, setToolsRunningCount] = createSignal(0);
	const toolsRunning = () => toolsRunningCount() > 0;
	const isLoading = () => activeStreams().size > 0 || toolsRunning();

	// Set on abort so a tool loop cancelled mid-run doesn't chain another turn;
	// cleared by the next user-initiated send (includeInput=true).
	let abortRequested = false;

	// The queued next turn: a copy of the input, sent once the current turn
	// (stream and tools) has ended. Queueing clears the input; dropping the queue (abort, failed
	// turn, unqueue) restores it.
	const [queuedSend, setQueuedSend] = createSignal<QueuedSend | null>(null);

	function queueSend(q: QueuedSend | null) {
		setQueuedSend(q);
		if (q) env.input?.clear();
	}

	function takeQueuedSend(restore = false): QueuedSend | null {
		const q = queuedSend();
		if (q) {
			setQueuedSend(null);
			if (restore) env.input?.restore?.(q);
		}
		return q;
	}

	// Messages from widgets that arrived during a turn: appended once it ends, in order
	let widgetQueue: { content: string; respond: boolean }[] = [];

	function appendWidgetMessage(content: string) {
		ui?.onUserAppend?.(messages.length);
		setMessages(messages.length, { role: 'user', content: [content], currentVersionIndex: 0, timing: [{ createdAt: Date.now() }] });
	}

	/** Appends the queued widget messages. Returns whether any of them asked for a response. */
	function flushWidgetQueue(): boolean {
		const queued = widgetQueue;
		widgetQueue = [];
		for (const { content } of queued) appendWidgetMessage(content);
		return queued.some(q => q.respond);
	}

	/**
	 * Adds a message from a widget to the chat as a user message, and starts a turn when `respond`.
	 * During a turn it waits in a queue. Throws when refused.
	 */
	function sendWidgetMessage(label: string, text: string, respond: boolean) {
		if (text.length > MAX_WIDGET_MESSAGE_CHARS)
			throw new Error(`widgetSend: the message is ${text.length} characters, over the limit of ${MAX_WIDGET_MESSAGE_CHARS}`);
		const content = formatWidgetMessage(label, text);
		if (isLoading()) {
			if (widgetQueue.length >= MAX_QUEUED_WIDGET_MESSAGES)
				throw new Error(`widgetSend: ${MAX_QUEUED_WIDGET_MESSAGES} messages are already waiting for the current turn to end`);
			widgetQueue.push({ content, respond });
			return;
		}
		appendWidgetMessage(content);
		if (respond) void sendMessage(-1, false);
	}

	/** Sends a queued turn; a queued `/compact` runs as the command instead of as message text. */
	function sendQueued(q: QueuedSend) {
		if (q.content.trim().startsWith('/compact')) return compactAndContinue();
		return sendMessage(-1, true, 0, q);
	}

	const abortAllStreams = () => {
		abortRequested = true;
		takeQueuedSend(true);
		for (const entries of activeStreams().values()) for (const { controller } of entries) controller.abort();
		setActiveStreams(new Map());
		env.onAbort?.();
		env.backend().cancelExec(shellSession()).catch(() => {});
		cancelJs(jsRuntimeKey(env.chatId(), shellSession()));
	};

	// ── Optimistic concurrency (Tauri) ─────────────────────────────────
	// Track the loaded chat's version and run every write for this session's chat
	// through one serialized chain, so meta and message flushes never race each
	// other on the version counter. A stale write (another view wrote first) is
	// rejected and shows a reload prompt instead of overwriting the other write.
	// `writeEpoch` invalidates queued writes when the active chat changes.
	let chatVersion = 0;
	let writeEpoch = 0;
	let writeChain: Promise<void> = Promise.resolve();
	let prevMessageLength = 0;
	const [chatConflict, setChatConflict] = createSignal(false);

	function enqueueWrite(write: (version: number) => Promise<number | undefined>): Promise<void> {
		const epoch = writeEpoch;
		const next = writeChain.then(async () => {
			if (epoch !== writeEpoch || chatConflict()) return;
			try {
				const v = await write(chatVersion);
				if (epoch === writeEpoch && typeof v === 'number') chatVersion = v;
			} catch (e) {
				if (epoch !== writeEpoch) return; // chat changed; drop stale failure
				if ((e as any)?.code === 'CONFLICT') setChatConflict(true);
				else console.error('Chat write failed:', e);
			}
		});
		writeChain = next;
		return next;
	}

	const dirtyIndices = new Set<number>();
	let flushPromise: Promise<void> | null = null;
	async function performDirtyFlush() {
		if (flushPromise || dirtyIndices.size === 0) return;
		try {
			const p = (async () => {
				const indices = dirtyIndices.has(-1)
					? Array.from({ length: messages.length }, (_, i) => i)
					: [...dirtyIndices];
				dirtyIndices.clear();
				// Clean up orphaned entries when the array shrank
				const currentLength = messages.length;
				for (let i = currentLength; i < prevMessageLength; i++) indices.push(i);
				prevMessageLength = currentLength;
				await enqueueWrite(version => saveDirtyMessages(indices, unwrap(messages), env.setError, version, env.chatId() || undefined));
			})();
			flushPromise = p;
			await p;
		} finally {
			flushPromise = null;
			if (dirtyIndices.size > 0) flushDirtyMessages();
		}
	}
	const flushDirtyMessages = leadingAndTrailing(throttle, performDirtyFlush, 4000);

	async function forceFlushDirty() {
		flushDirtyMessages.clear();
		if (flushPromise) await flushPromise;
		await performDirtyFlush();
	}

	/** Wrapper around _setMessages that auto-tracks dirty indices for persistence */
	const setMessages: typeof _setMessages = (...args: any[]) => {
		const index = args[0];
		if (typeof index === 'number') dirtyIndices.add(index);
		else dirtyIndices.add(-1); // full array op (splice, replace, etc.)
		(_setMessages as any)(...args);
		flushDirtyMessages();
	};

	function setMessageContent(index: number, updater: (current: string) => string) {
		setMessages(index, "content", messages[index].currentVersionIndex || 0, prev => updater(prev));
	}

	function deleteMessage(index: number) {
		env.onSplice?.(index, -1);
		const dbId = messages[index]._dbId;
		if (dbId !== undefined) {
			// Tauri/SQLite: delete by stable row id, no need to re-save shifted messages
			(_setMessages as any)((draft: ChatMessage[]) => draft.slice(0, index).concat(draft.slice(index + 1)));
			const id = env.chatId();
			enqueueWrite(version => deleteMessageById(dbId, env.setError, id, version));
		} else {
			// Web/IndexedDB: mark shifted indices dirty for positional re-save
			const oldLength = messages.length;
			for (let i = index; i < oldLength; i++) dirtyIndices.add(i);
			(_setMessages as any)((draft: ChatMessage[]) => draft.slice(0, index).concat(draft.slice(index + 1)));
			flushDirtyMessages();
		}
	}

	/** Insert `msg` before `index` (`messages.length` appends). */
	function insertMessage(index: number, msg: ChatMessage) {
		env.onSplice?.(index, 1);
		(_setMessages as any)((draft: ChatMessage[]) => [...draft.slice(0, index), msg, ...draft.slice(index)]);
		const id = env.chatId();
		if (isTauri && id) {
			// SQLite: shift later rows and insert by position; their row ids stay valid
			const inserted = unwrap(messages)[index];
			enqueueWrite(version => insertMessageAt(id, index, inserted, env.setError, version));
		} else {
			// Web/IndexedDB: positional re-save of everything from the insert point
			for (let i = index; i < messages.length; i++) dirtyIndices.add(i);
			flushDirtyMessages();
		}
	}

	// ── Lifecycle ───────────────────────────────────────────────────────

	/** Replaces the messages with freshly loaded ones: repairs unfinished tool calls, sets the chat version and clears the conflict flag. */
	function load(msgs: ChatMessage[], version: number) {
		repairOrphanedToolCalls(msgs);
		_setMessages(msgs);
		prevMessageLength = msgs.length;
		chatVersion = version;
		dirtyIndices.clear();
		setChatConflict(false);
		ui?.onMessagesLoaded?.();
	}

	/** Flush pending message writes and drain the write queue. */
	async function flush() {
		await forceFlushDirty();
		await writeChain;
	}

	/** Drops queued and in-flight writes and unsaved dirty indices (reload/delete). */
	function discardPending() {
		writeEpoch++;
		flushDirtyMessages.clear();
		dirtyIndices.clear();
	}

	const hasPendingWrites = () => dirtyIndices.size > 0 || flushPromise !== null;

	// ── Message lookup ──────────────────────────────────────────────────

	let cachedMessageIndex = -1;

	function findMessageIndex(target: ChatMessage, index?: number): number {
		if (typeof index === 'number' && index >= 0 && index < messages.length) {
			const msgAtIndex = messages[index];
			if (messages[index] === target ||
				(JSON.stringify(msgAtIndex.content) === JSON.stringify(target.content) &&
					JSON.stringify(msgAtIndex.thinking || []) === JSON.stringify(target.thinking || []))) {
				cachedMessageIndex = index;
			}
		}

		if (cachedMessageIndex >= 0 && cachedMessageIndex < messages.length) {
			const msgAtIndex = messages[cachedMessageIndex];
			if (msgAtIndex === target ||
				(JSON.stringify(msgAtIndex.content) === JSON.stringify(target.content) &&
					JSON.stringify(msgAtIndex.thinking || []) === JSON.stringify(target.thinking || [])))
				return cachedMessageIndex;
		}

		// Fallback to content-based search (slower but handles edge cases)
		console.warn("Doing full search for message index");
		const contentIndex = messages.findIndex(msg =>
			msg === target ||
			msg.role === target.role &&
			JSON.stringify(msg.content) === JSON.stringify(target.content) &&
			JSON.stringify(msg.thinking || []) === JSON.stringify(target.thinking || [])
		);

		if (contentIndex !== -1)
			cachedMessageIndex = contentIndex;

		return contentIndex;
	};

	// ── Send / stream / tool loop ───────────────────────────────────────

	const toolMode = () => toolModeOf(env.activeConfig());

	const SPIRAL_RECOVERY_NOTICE =
		'[Automated Response] Your previous response was interrupted because it got stuck repeating itself. ' +
		'Continue normally';

	async function sendMessage(redo: number | undefined, includeInput: boolean = true, spiralRecovery: number = 0, queuedInput?: QueuedSend): Promise<StreamingResult | undefined> {
		if (includeInput) abortRequested = false;
		const redoing = typeof redo === 'number' && redo >= 0;

		if (!env.model()) {
			console.error('no model :(', env.model());
			env.setError("Please set a model")
			return undefined;
		}

		const mrole = queuedInput?.role ?? env.input?.role() ?? 'user';

		// await loadPools(); // to avoid race, probably not needed

		const userMessageContent = msgVars((queuedInput?.content ?? env.input?.value() ?? '').trim(), env.macros(), env.model(), env.chatFolder(), env.chatId());

		let originalMessage: ChatMessage | null = null;

		if (redoing) {
			originalMessage = structuredClone(unwrap(messages[redo]));
			// Check streaming status before setMessages, using the message that will be in the store
			const currentMsg = messages[redo];
			const vi = currentMsg.currentVersionIndex || 0;
			const hasContent = getMessageContent(currentMsg).trim();
			const hasThinking = getMessageThinking(currentMsg)?.trim();
			const hasToolCalls = currentMsg.tool_calls?.[vi]?.length;
			const isStreaming = activeStreams().has(currentMsg);  // any version streaming
			const needsNewVersion = hasContent || hasThinking || hasToolCalls || isStreaming;

			setMessages(redo, prev => {
				if (!needsNewVersion) return prev;
				return addMessageVersion(prev, { content: '', model: env.model(), provider: env.provider() });
			});
			if (redo > 0) setMessageContent(redo-1, content => msgVars(content, env.macros(), env.model(), env.chatFolder(), env.chatId())) // expand macros in the previous message
		} else {
			originalMessage = structuredClone(unwrap(messages[messages.length-1]));
			const inputImages = queuedInput?.images ?? env.input?.images() ?? [];
			const inputFiles = queuedInput?.files ?? env.input?.files() ?? [];
			if ((userMessageContent || inputImages.length || inputFiles.length) && includeInput) {
				const loreContent = reLore(userMessageContent, messages, env.lore);
				if (loreContent)
					setMessages(messages.length, { role: 'user', content: [loreContent], temporary: true, currentVersionIndex: 0 });

				const newUserMessage: ChatMessage = { role: mrole, content: [userMessageContent], currentVersionIndex: 0, timing: [{ createdAt: Date.now() }] };
				if (inputImages.length) newUserMessage.images = [inputImages];
				if (inputFiles.length) newUserMessage.files = [inputFiles];
				ui?.onUserAppend?.(messages.length);
				setMessages(messages.length, newUserMessage);
				// A queued send has its own copy of the input; the live input may hold
				// the message the user is typing next.
				if (!queuedInput) env.input?.clear();

				// setMessages(prev => prev.filter((m, i) => !m.temporary || i >= prev.length-9)) // remove old lore (and tools) messages
			}
		}

		let rqstMsgs: ChatMessage[] | Message[] = structuredClone(sentMessages(unwrap(messages), env.cut(), env.folds?.(), redoing ? redo : messages.length));

		let targetMessage: ChatMessage;
		let targetIndex: number;
		if (redoing) {
			targetMessage = messages[redo];
			targetIndex = redo;
		} else {
			const lastMsg = messages[messages.length-1];
			const lastVi = lastMsg.currentVersionIndex || 0;
			const hasToolResults = lastMsg.role === 'assistant' && lastMsg.tool_results?.[lastVi]?.length;
			if (lastMsg.role !== 'assistant' || hasToolResults)
				setMessages(messages.length, { role: 'assistant', content: [''], currentVersionIndex: 0, models: [env.model()], providers: [env.provider()], timing: [{ createdAt: Date.now() }] }); // add empty msg to stream into
			else if (activeStreams().has(lastMsg))
				// The last message is still streaming: stream into a new version, not the same one.
				setMessages(messages.length-1, prev => addMessageVersion(prev, { content: '', model: env.model(), provider: env.provider() }));

			targetIndex = messages.length-1;
			targetMessage = messages[targetIndex];
		}
		const msgVersion = targetMessage.currentVersionIndex || 0;

		await inlineAttachments(rqstMsgs as ChatMessage[], { nested: false });

		const resolvedOptions = resolveConfigOptions(env.options(), env.activeConfig(), env.model());
		rqstMsgs = buildRequestMessages(rqstMsgs as ChatMessage[], {
			preserveReasoning: resolvedOptions.preserve_reasoning,
			provider: env.provider(),
			reasoningPrefill: env.activeConfig()?.reasoningPrefill,
			prompts: env.promptMessages(),
			cache: env.cache(),
			cacheLength: env.cacheLength(),
			model: env.model()
		});

		// Visible sessions only: sub-agent requests would push the visible chats' baselines out of the LRU
		const cacheRequest = env.input === undefined ? undefined : preSendCheck(env.chatId(), {
			model: env.model(),
			provider: env.provider(),
			cacheLength: env.cacheLength(),
			cacheEnabled: env.cache() !== 'none',
			reasoningEffort: resolvedOptions.reasoning?.effort,
			tools: sentTools(env.activeConfig()?.tools, env.backend(), env.model(), env.provider(), toolMode(), env.activeConfig()?.agentPresets),
		}, rqstMsgs);

		env.setError(null);
		// Info messages persist through tool loops so auto-compact/cache notices stay
		// visible; they auto-dismiss via the setInfo timeout in App. A fresh user send clears them.
		if (includeInput) env.setInfo(null);

		// # actual send
		// The pending check must not outlive its request: setup (before the stream's own try) or
		// the stream itself can throw.
		let result: Awaited<ReturnType<typeof handleStreamingResponse>>;
		try {
			result = await handleStreamingResponse(targetMessage, targetIndex, rqstMsgs, cacheRequest);
		} catch (error) {
			if (cacheRequest !== undefined) postResponseCheck(cacheRequest, undefined, false);
			throw error;
		}

		const currentIndex = findMessageIndex(targetMessage, targetIndex);

		if (compaction) {
			const { est, force } = compaction;
			compaction = undefined;
			if (result.success && currentIndex !== -1) {
				if (isAdequateSummary(getMessageContent(messages[currentIndex]))) {
					lastCompactIndex = currentIndex;
					env.setCut?.(Math.max(1, currentIndex - COMPACT_LOOKBACK));
					env.setInfo(`Auto-compacted context (~${est.toLocaleString()} est. tokens)`);
				} else {
					deleteMessage(currentIndex);     // the too-short summary
					deleteMessage(currentIndex - 1); // the compaction prompt
					// Cooldown, so a failing model isn't retried on every loop round.
					lastCompactIndex = messages.length;
					env.setInfo('Auto-compaction failed: summary was too short; context unchanged');
					return force ? result : sendMessage(-1, false);
				}
			}
		}

		if (result.success && result.toolCalls) {
			const mode = toolMode();
			const toolCalls = mode === 'run' ? expandRunCalls(result.toolCalls) : mode === 'js' ? wrapInRunJs(result.toolCalls) : result.toolCalls;
			const msg = messages[currentIndex];
			const existingCalls = msg.tool_calls?.[msgVersion] || [];
			const toolCallsArray = insertAtIndex(msg.tool_calls, msgVersion, [...existingCalls, ...toolCalls], []);
			setMessages(currentIndex, 'tool_calls', toolCallsArray);

			// Pre-allocate tool_results slots in calling order (empty content = pending)
			const placeholders: ToolResult[] = toolCalls.map(tc => ({
				tool_call_id: tc.id,
				name: tc.function.name
			}));
			const preMsg = messages[currentIndex];
			const existingResults = preMsg.tool_results?.[msgVersion] || [];
			setMessages(currentIndex, 'tool_results',
				insertAtIndex(preMsg.tool_results, msgVersion, [...existingResults, ...placeholders], []));

			const chatMessages = (): ChatSnapshot => {
				const visible = unwrap(messages).slice(0, findMessageIndex(targetMessage, targetIndex) + 1);
				return { messages: visible, cut: cutStart(env.cut(), visible.length), folds: env.folds?.() };
			};
			setToolsRunningCount(c => c + 1);
			try {
				const results = await applyToolCalls(toolCalls, {
					...toolContext(),
					enabledTools: runnableTools(env.activeConfig()?.tools, toolMode()),
					dismissPermission: env.dismissPermission,
					// Only messages up to this turn: when regenerating, run_js state saved by later messages must not be restored.
					latestJsState: () => latestJsState(messages.slice(0, findMessageIndex(targetMessage, targetIndex) + 1)),
					chatMessages,
					fold: env.setFolds && ((id, args) => {
						const fold = planFold(chatMessages(), id, args);
						if (!('error' in fold)) env.setFolds!([...env.folds?.() ?? [], fold]);
						return fold;
					}),
					parentChat: env.parentChat,
					onResult: (tr) => {
						const ci = findMessageIndex(targetMessage, targetIndex);
						const m = messages[ci];
						const results = m.tool_results?.[msgVersion] || [];
						const idx = results.findIndex(r => r.tool_call_id === tr.tool_call_id);
						if (idx >= 0) {
							// Patch the result rather than the `data` key: setting a store key
							// whose old and new values are both objects *merges* them, which
							// would leave stale fields (a finished shell keeping running:true)
							// and mutate data in place, defeating format caching by identity.
							setMessages(ci, 'tool_results', msgVersion, idx, { data: tr.data });
							ui?.afterAppend?.();
						}
					},
				});

				const queued = takeQueuedSend();
				const widgetResponse = flushWidgetQueue();
				if (queued) {
					sendQueued(queued);
				} else if (!abortRequested && ((env.sendMode() === 'loop' && !results.some(r => r.data.denied)) || widgetResponse)) {
					maybeAutoCompact();
					sendMessage(-1, false);
				}
			} finally {
				setToolsRunningCount(c => c - 1);
			}

		} else if (result.error === 'aborted') {
			// Per-message aborts bypass abortAllStreams, so the queue may still be set.
			takeQueuedSend(true);
			if (currentIndex !== -1 && getMessageContent(messages[currentIndex]) === userMessageContent)
				env.input?.clear();
			flushWidgetQueue();
		} else if (result.success && result.finishReason === 'repetition' && env.sendMode() === 'loop' && spiralRecovery < 3) {
			setMessages(messages.length, {
				role: 'user',
				content: [SPIRAL_RECOVERY_NOTICE],
				currentVersionIndex: 0,
				timing: [{ createdAt: Date.now() }]
			});
			sendMessage(-1, false, spiralRecovery + 1);
		} else if (!result.success) {
			takeQueuedSend(true);
			env.setError(`Failed to get response: ${result.error || 'unknown error'}`);
			if (currentIndex === -1) setMessages(prev => prev.slice(0, -1));
			if (redoing && currentIndex !== -1 && originalMessage)
				setMessages(currentIndex, originalMessage);
			flushWidgetQueue();
		} else {
			// Plain-text turn end (no tool calls) with a queued message.
			const queued = takeQueuedSend();
			const widgetResponse = flushWidgetQueue();
			if (queued) sendQueued(queued);
			else if (widgetResponse) sendMessage(-1, false);
		}

		return result;
	};

	// ── Auto-compaction ───────────────────────────────────────────────
	// Runs in loop mode when the per-chat toggle is on (pure helpers are in helpers/compact.ts).
	// Once the estimated post-cut context passes the global threshold, the compaction
	// prompt is added as a user message and the turn that follows is an ordinary one, with
	// the same tools, so the model can re-read files itself. When its response arrives
	// (see `compaction` in sendMessage) the summary is checked and the cut moves to
	// COMPACT_LOOKBACK messages before it.
	let lastCompactIndex = -1;
	let compaction: { est: number; force: boolean } | undefined;

	function maybeAutoCompact(force = false) {
		if (!env.setCut || !env.compactSettings) return;
		if (!force && (!env.autoCompact?.() || env.sendMode() !== 'loop')) return;
		const settings = env.compactSettings();
		if (!force && !(settings.tokens > 0)) return;

		const cfg = env.activeConfig();
		const est = estimateContextTokens(sentMessages(unwrap(messages), env.cut(), env.folds?.()), env.model(), {
			reasoning: cfg?.preserveReasoning,
			extraChars: env.promptMessages().reduce((sum, p) => sum + p.content.length, 0)
				+ JSON.stringify(sentTools(cfg?.tools, env.backend(), env.model(), env.provider(), toolMode(), cfg?.agentPresets)).length,
		});
		if (!force && est <= settings.tokens) return;
		// Require 8 new messages since the last compaction; otherwise a context that
		// stays above the threshold would be compacted on every turn.
		if (!force && lastCompactIndex >= 0 && messages.length - lastCompactIndex < 8) return;

		setMessages(messages.length, { role: 'user', content: [msgVars(settings.prompt, env.macros(), env.model(), env.chatFolder(), env.chatId())], currentVersionIndex: 0, timing: [{ createdAt: Date.now() }] });
		compaction = { est, force };
		env.setInfo('Auto-compacting context…');
	}

	// Helper function for common streaming logic
	async function handleStreamingResponse(
		targetMessage: ChatMessage,
		targetIndex: number,
		rqstMsgs: Message[],
		cacheRequest: number | undefined = undefined
	) {
		const msgVersion = targetMessage.currentVersionIndex || 0;

		// Pre-initialize arrays to ensure proper structure before streaming
		const msg = messages[targetIndex];
		setMessages(targetIndex, 'content', insertAtIndex(msg.content, msgVersion, msg.content?.[msgVersion] ?? '', ''));
		setMessages(targetIndex, 'thinking', insertAtIndex(msg.thinking, msgVersion, msg.thinking?.[msgVersion] ?? '', ''));
		setMessages(targetIndex, 'ids', insertAtIndex(msg.ids, msgVersion, msg.ids?.[msgVersion] ?? '', ''));

		const streamKey = targetMessage;
		const controller = new AbortController();
		setActiveStreams(prev => { const m = new Map(prev); m.set(streamKey, [...(m.get(streamKey) || []), { controller, versionIndex: msgVersion }]); return m; });

		const directAppend = (field: 'content' | 'thinking') => (text: string) => {
			const i = findMessageIndex(targetMessage, targetIndex);
			if (i !== -1) setMessages(i, field, msgVersion, prev => (prev ?? '') + text);
			ui?.afterAppend?.();
		};

		const msgWeight = () => messages.length;
		const useDrip = ui?.textDrip?.() ?? false;
		const contentDrip = useDrip ? createTextDrip(directAppend('content'), msgWeight) : null;
		const reasoningDrip = useDrip ? createTextDrip(directAppend('thinking'), msgWeight) : null;

		try {
			const p = env.providers()[env.provider()];
			const result = await (env.stream ?? streamChatCompletion)(env.model(), rqstMsgs, resolveConfigOptions(env.options(), env.activeConfig(), env.model()),
					p.apiKey, SITE_NAME,
					controller.signal,
					env.provider(),
					p.url,
					p.apiType,
					content => contentDrip ? contentDrip.push(content) : directAppend('content')(content),
					reasoning => reasoningDrip ? reasoningDrip.push(reasoning) : directAppend('thinking')(reasoning),
					env.setError,
					id => {
						const currentIndex = findMessageIndex(targetMessage, targetIndex);
						if (currentIndex !== -1) {
							setMessages(currentIndex, "ids", msgVersion, id);
						}
					},
					env.setInfo,
					env.activeConfig()?.tools,
					env.cache() !== 'none' && (isGpt56OrLater(env.model()) || env.provider() === 'or' || env.provider() === 'anth_local' || env.provider() === 'nano' || p.apiType === 'responses')
						? { type: 'ephemeral', ttl: isGpt56OrLater(env.model()) ? '30m' : env.cacheLength() }
						: undefined,
					env.chatId(),
					toolMode(),
					providerLabel(env.provider(), env.providers()),
					env.activeConfig()?.agentPresets
			);

			// Flush remaining buffered text before processing the result. The flush must be
			// awaited, or code that reads the message afterwards (auto-compaction) gets truncated content.
			await Promise.all([contentDrip?.flush(), reasoningDrip?.flush()]);

			const currentIndex = findMessageIndex(targetMessage, targetIndex);

			// Stats are kept even on a cancelled stream, since the partial response is kept too
			if (result.usage && currentIndex !== -1) {
				const msg = messages[currentIndex];
				const usageArray = insertAtIndex(msg.usage, msgVersion, result.usage, { prompt_tokens: 0, message_tokens: 0, reasoning_tokens: 0, prompt_cost: 0, message_cost: 0 });
				setMessages(currentIndex, 'usage', usageArray);
			}

			if (result.timing && currentIndex !== -1) {
				const msg = messages[currentIndex];
				const prev = msg.timing?.[msgVersion];
				const timingArray = insertAtIndex(msg.timing, msgVersion, { ...result.timing, createdAt: prev?.createdAt, editedAt: prev?.editedAt }, {});
				setMessages(currentIndex, 'timing', timingArray);
			}

			if (cacheRequest !== undefined) {
				const check = postResponseCheck(cacheRequest, result.usage, result.success);
				if (check && shouldNotifyMiss(check))
					env.setInfo(`Prompt cache miss: expected ~${Math.round(expectedCachedTokens(check)!).toLocaleString()} cached tokens, got ${check.cached!.toLocaleString()}. Check the cache indicator for details.`);
			}

			if (result.thinking_signature && currentIndex !== -1) {
				const msg = messages[currentIndex];
				const sigArray = insertAtIndex(msg.thinking_signature, msgVersion, result.thinking_signature, '');
				setMessages(currentIndex, 'thinking_signature', sigArray);
			}

			if (result.reasoning_enc && currentIndex !== -1) {
				const msg = messages[currentIndex];
				const encArray = insertAtIndex(msg.reasoning_enc, msgVersion, result.reasoning_enc, []);
				setMessages(currentIndex, 'reasoning_enc', encArray);
			}

			if (result.success && currentIndex !== -1 && !(env.sendMode() === 'loop' && result.toolCalls))
				ui?.onStreamDone?.(getMessageContent(messages[currentIndex]));

			return result;
		} finally {
			await Promise.all([contentDrip?.flush(), reasoningDrip?.flush()]);
			setActiveStreams(prev => {
				const m = new Map(prev);
				const entries = (m.get(streamKey) || []).filter(e => e.versionIndex !== msgVersion);
				if (entries.length > 0) m.set(streamKey, entries); else m.delete(streamKey);
				return m;
			});
		}
	}

	/** /compact: force a compaction regardless of toggle/threshold/loop mode, then continue the chat. */
	async function compactNow() {
		if (isLoading()) return;
		await compactAndContinue();
	}

	async function compactAndContinue() {
		maybeAutoCompact(true);
		await sendMessage(-1, false);
	}

	async function sendAsideMessage(content: string) {
		if (isLoading()) return;

		if (!env.model()) {
			console.error('no model :(', env.model());
			env.setError("Please set a model")
			return;
		}

		abortAllStreams();

		ui?.onUserAppend?.(messages.length);
		setMessages(messages.length, { role: 'user', content: [content], currentVersionIndex: 0, timing: [{ createdAt: Date.now() }] });
		setMessages(messages.length, { role: 'assistant', content: [''], currentVersionIndex: 0, timing: [{ createdAt: Date.now() }] });

		const targetIndex = messages.length-1;
		const targetMessage = messages[targetIndex];
		const rqstMsgs: Message[] = [{ role: 'user', content: content }];

		env.setError(null);

		await handleStreamingResponse(targetMessage, targetIndex, rqstMsgs);
	}

	async function sendRewriteMessage(content: string) {
		if (isLoading()) return;

		if (!env.model()) {
			console.error('no model :(', env.model());
			env.setError("Please set a model")
			return;
		}

		// Find the last assistant message
		let lastAssistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant' && getMessageContent(messages[i]).trim() !== '') {
				lastAssistantIndex = i;
				break;
			}
		}

		if (lastAssistantIndex === -1) {
			env.setError("No assistant message found to rewrite");
			return;
		}

		const lastAssistantMessage = messages[lastAssistantIndex];
		const originalContent = getMessageContent(lastAssistantMessage);

		abortAllStreams();

		// Create a new version of the message to stream into
		setMessages(lastAssistantIndex, prev =>
			addMessageVersion(prev, { content: '', model: env.model(), provider: env.provider() })
		);

		const targetMessage = messages[lastAssistantIndex];
		const targetIndex = lastAssistantIndex;

		// Create a request that asks the model to rewrite the content
		const rewritePrompt = `<message>
${originalContent}
</message>

Rewrite the message above following this instruction: "${content}"

Output only the rewritten message, with no commentary.`;

		const rqstMsgs: Message[] = [{ role: 'user', content: rewritePrompt }];

		env.setError(null);

		await handleStreamingResponse(targetMessage, targetIndex, rqstMsgs);
	}

	/**
	 * Runs a `rerunnable` tool's call again with new arguments and replaces its result.
	 * The send loop does not continue afterwards.
	 */
	async function rerunToolCall(targetMessage: ChatMessage, targetIndex: number, version: number, callId: string, args: {}) {
		const index = findMessageIndex(targetMessage, targetIndex);
		const call = messages[index]?.tool_calls?.[version]?.find(c => c.id === callId);
		const callIdx = messages[index]?.tool_calls?.[version]?.findIndex(c => c.id === callId) ?? -1;
		const resultIdx = messages[index]?.tool_results?.[version]?.findIndex(r => r.tool_call_id === callId) ?? -1;
		const previous = structuredClone(unwrap(messages[index]?.tool_results?.[version]?.[resultIdx]?.data));
		if (!call || resultIdx < 0 || call.parent !== undefined || !toolModules[call.function.name]?.rerunnable) return;

		// Patch the call and result rather than their `function` / `data` keys: see onResult in sendMessage.
		const fn = { name: call.function.name, arguments: args };
		setMessages(index, 'tool_calls', version, callIdx, { function: fn });
		setMessages(index, 'tool_results', version, resultIdx, { data: undefined, content: undefined });
		setToolsRunningCount(c => c + 1);
		try {
			await applyToolCalls([{ id: callId, type: 'function', function: fn }], {
				...toolContext(),
				enabledTools: { [fn.name]: true }, // like auto-reads, bypasses the config's tool selection
				previous,
				onResult: tr => {
					const ci = findMessageIndex(targetMessage, targetIndex);
					const idx = messages[ci]?.tool_results?.[version]?.findIndex(r => r.tool_call_id === callId) ?? -1;
					if (idx >= 0) setMessages(ci, 'tool_results', version, idx, { data: tr.data });
				},
			});
		} finally {
			setToolsRunningCount(c => c - 1);
		}
	}

	return {
		messages, setMessages,
		sendMessage, sendWidgetMessage, rerunToolCall, sendAsideMessage, sendRewriteMessage, compactNow,
		deleteMessage, insertMessage, setMessageContent,
		load, flush, discardPending, hasPendingWrites,
		enqueueWrite,
		version: () => chatVersion,
		abortAllStreams,
		isLoading: isLoading as Accessor<boolean>,
		toolsRunning: toolsRunning as Accessor<boolean>,
		queuedSend: queuedSend as Accessor<QueuedSend | null>,
		queueSend,
		activeStreams,
		chatConflict,
	};
}
