import { createSignal, type Accessor, type Setter } from 'solid-js';
import { createStore, unwrap, type SetStoreFunction } from 'solid-js/store';
import { throttle, leadingAndTrailing } from '@solid-primitives/scheduled';

import { saveDirtyMessages, deleteMessageById, stagedSetMessages } from './storage';
import { isTauri } from './platform';
import { streamChatCompletion, type StreamingResult } from './streaming';
import { getMessageContent, getMessageThinking, insertAtIndex, addMessageVersion, repairOrphanedToolCalls } from './messages';
import { buildRequestMessages, type PromptMessage } from './buildRequest';
import { inlineAttachments } from './attachments';
import { createTextDrip } from './textDrip';
import { reLore, msgVars } from './Extras';
import { applyToolCalls } from './tools';
import { resolveConfigOptions } from './PromptManager';
import type { LoreEntry } from './lore';
import type { cacheType, cacheLength, Config, ChatMessage, Provider, ProviderConfig, Options, Role, Message, ToolResult } from './types';

const SITE_NAME = 'Nugram';

/**
 * Everything a session needs from the outside world, as accessors so the
 * visible session stays live-bound to App's signals. Headless sessions
 * (sub-agents) pass frozen closures over a snapshot instead.
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
	lore: LoreEntry[];
	setLore: SetStoreFunction<LoreEntry[]>;
	requestPermission: (toolCall: any, chatName?: string) => Promise<true | string>;
	/** Key for per-session shell state in the Tauri backend (previous output, cancellation). */
	shellSession: string;
	setError: Setter<string | null>;
	setInfo: Setter<string | null>;
	/** Chat input binding — visible session only. Headless sessions seed messages directly. */
	input?: { value: () => string; images: () => string[]; files: () => import('./types').FileAttachment[]; clear: () => void; role: () => Role };
	/** Runs a spawn_agent tool call. Absent = tool unavailable (web build, or a sub-agent). */
	spawnAgent?: ((args: any, callId?: string) => Promise<string>) | undefined;
	/** Called on abortAllStreams — propagates cancellation to spawned sub-agents. */
	onAbort?: (() => void) | undefined;
	/** Streaming implementation override (tests). Defaults to streamChatCompletion. */
	stream?: typeof streamChatCompletion | undefined;
}

/** UI hooks — only the visible session provides these. */
export interface SessionUI {
	textDrip?: () => boolean;
	/** Called after streamed content is appended (scroll-follow). */
	afterAppend?: () => void;
	/** Called when a stream finishes successfully (notifications). */
	onStreamDone?: (content: string) => void;
	timers?: {
		setActive: (active: boolean) => void;
		setRemaining: (remaining: number) => void;
		setReady: (ready: boolean) => void;
		setDuration: (duration: number) => void;
	};
}

export type ChatSession = ReturnType<typeof createChatSession>;

/**
 * A self-contained chat engine: message store with dirty-tracked persistence,
 * serialized optimistic-concurrency writes, streaming, and the tool loop.
 * The visible chat is one session; sub-agents are headless ones.
 * No reactive computations are created here, so sessions can live outside the
 * component tree.
 */
export function createChatSession(env: SessionEnv, ui?: SessionUI) {
	const [messages, _setMessages] = createStore<ChatMessage[]>([]);
	const [activeStreams, setActiveStreams] = createSignal<Map<ChatMessage, { controller: AbortController; versionIndex: number }[]>>(new Map());
	const [toolsRunning, setToolsRunning] = createSignal(false);
	const isLoading = () => activeStreams().size > 0 || toolsRunning();

	const abortAllStreams = () => {
		for (const entries of activeStreams().values()) for (const { controller } of entries) controller.abort();
		setActiveStreams(new Map());
		env.onAbort?.();
		if (isTauri) import('@tauri-apps/api/core').then(({ invoke }) => invoke('cancel_shell', { session: env.shellSession }).catch(() => {}));
	};

	// ── Optimistic concurrency (Tauri) ─────────────────────────────────
	// Track the loaded chat's version and run every write for this session's chat
	// through one serialized chain, so meta + message flushes never race each
	// other on the version counter. A stale write (another view wrote first) is
	// rejected and surfaces a reload prompt instead of silently clobbering.
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

	// ── Lifecycle ───────────────────────────────────────────────────────

	/** Replace the session's messages with freshly loaded state (repairs, resets versioning + conflict). */
	function load(msgs: ChatMessage[], version: number) {
		repairOrphanedToolCalls(msgs);
		stagedSetMessages(msgs, _setMessages);
		prevMessageLength = msgs.length;
		chatVersion = version;
		dirtyIndices.clear();
		setChatConflict(false);
	}

	/** Flush pending message writes and drain the write queue. */
	async function flush() {
		await forceFlushDirty();
		await writeChain;
	}

	/** Drop queued/in-flight writes (the chat is changing under us). */
	function invalidateWrites() {
		writeEpoch++;
	}

	/** Drop queued/in-flight writes AND unsaved local dirt (reload/delete paths). */
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

	const SPIRAL_RECOVERY_NOTICE =
		'[Automated Reponse] Your previous response was interrupted because it got stuck repeating itself. ' +
		'Continue normally';

	async function sendMessage(redo: number | undefined, includeInput: boolean = true, spiralRecovery: number = 0): Promise<StreamingResult | undefined> {
		const redoing = typeof redo === 'number' && redo >= 0;

		if (!env.model()) {
			console.error('no model :(', env.model());
			env.setError("Please set a model")
			return undefined;
		}

		const mrole = env.input?.role() ?? 'user';

		const userMessageContent = msgVars((env.input?.value() ?? '').trim(), env.macros(), env.model(), env.chatFolder(), env.chatId());

		let originalMessage: ChatMessage | null = null;

		if (redoing) {
			originalMessage = structuredClone(unwrap(messages[redo]));
			// Check streaming status BEFORE setMessages, using the message that will be in the store
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
			if (redo > 0) setMessageContent(redo-1, content => msgVars(content, env.macros(), env.model(), env.chatFolder(), env.chatId())) // set vars for prev msg
		} else {
			originalMessage = structuredClone(unwrap(messages[messages.length-1]));
			const inputImages = env.input?.images() ?? [];
			const inputFiles = env.input?.files() ?? [];
			if ((userMessageContent || inputImages.length || inputFiles.length) && includeInput) {
				const loreContent = reLore(userMessageContent, messages, env.lore);
				if (loreContent)
					setMessages(messages.length, { role: 'user', content: [loreContent], temporary: true, currentVersionIndex: 0 });

				const newUserMessage: ChatMessage = { role: mrole, content: [userMessageContent], currentVersionIndex: 0, timing: [{ createdAt: Date.now() }] };
				if (inputImages.length) newUserMessage.images = [inputImages];
				if (inputFiles.length) newUserMessage.files = [inputFiles];
				setMessages(messages.length, newUserMessage);
				env.input?.clear();

				// setMessages(prev => prev.filter((m, i) => !m.temporary || i >= prev.length-9)) // remove old lore (and tools) messages
			}
		}

		const cut = env.cut();
		const actualCutIndex = cut > 0 && cut < messages.length ? cut : 0;
		let rqstMsgs: ChatMessage[] | Message[] = structuredClone(unwrap(messages.slice(actualCutIndex)));

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

			targetIndex = messages.length-1;
			targetMessage = messages[targetIndex];
		}
		const msgVersion = targetMessage.currentVersionIndex || 0;

		if (redoing)
			rqstMsgs = rqstMsgs.slice(0, redo - actualCutIndex);

		await inlineAttachments(rqstMsgs as ChatMessage[]);

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

		env.setError(null);
		env.setInfo(null);

		const result = await handleStreamingResponse(targetMessage, targetIndex, rqstMsgs);

		const currentIndex = findMessageIndex(targetMessage, targetIndex);

		if (result.success && result.toolCalls) {
			const msg = messages[currentIndex];
			const existingCalls = msg.tool_calls?.[msgVersion] || [];
			const toolCallsArray = insertAtIndex(msg.tool_calls, msgVersion, [...existingCalls, ...result.toolCalls], []);
			setMessages(currentIndex, 'tool_calls', toolCallsArray);

			// Pre-allocate tool_results slots in calling order (empty content = pending)
			const placeholders: ToolResult[] = result.toolCalls.map(tc => ({
				tool_call_id: tc.id,
				name: tc.function.name
			}));
			const preMsg = messages[currentIndex];
			const existingResults = preMsg.tool_results?.[msgVersion] || [];
			setMessages(currentIndex, 'tool_results',
				insertAtIndex(preMsg.tool_results, msgVersion, [...existingResults, ...placeholders], []));

			setToolsRunning(true);
			try {
				await applyToolCalls(result.toolCalls, {
					timers: ui?.timers,
					lore: env.lore,
					setLore: env.setLore,
					chatFolder: env.chatFolder(),
					chatId: env.chatId(),
					shellSession: env.shellSession,
					spawnAgent: env.spawnAgent,
					enabledTools: env.activeConfig()?.tools,
					requestPermission: (tc) => env.requestPermission(tc),
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

				// todo this also sends the current input as a message, which I can't decide is great or annoying
				// update it can happen *mid* typing, which is bad. But we do want a way to send a message after the current tool finishes without interrupting it
				if (env.sendMode() === 'loop') sendMessage(-1, false);
			} finally {
				setToolsRunning(false);
			}

		} else if (result.error === 'aborted') {
			if (currentIndex !== -1 && getMessageContent(messages[currentIndex]) === userMessageContent)
				env.input?.clear();
		} else if (result.success && result.finishReason === 'repetition' && env.sendMode() === 'loop' && spiralRecovery < 3) {
			setMessages(messages.length, {
				role: 'user',
				content: [SPIRAL_RECOVERY_NOTICE],
				currentVersionIndex: 0,
				timing: [{ createdAt: Date.now() }]
			});
			sendMessage(-1, false, spiralRecovery + 1);
		} else if (!result.success) {
			env.setError(`Failed to get response: ${result.error || 'unknown error'}`);
			if (currentIndex === -1) setMessages(prev => prev.slice(0, -1));
			if (redoing && currentIndex !== -1 && originalMessage)
				setMessages(currentIndex, originalMessage);
		}

		return result;
	};

	// Helper function for common streaming logic
	async function handleStreamingResponse(
		targetMessage: ChatMessage,
		targetIndex: number,
		rqstMsgs: Message[]
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
					env.cache() !== 'none' && (env.provider() === 'or' || env.provider() === 'anth_local' || env.provider() === 'nano')
						? { type: 'ephemeral', ttl: env.cacheLength() }
						: undefined
			);

			// Flush remaining buffered text before processing result
			contentDrip?.flush();
			reasoningDrip?.flush();

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

			if (result.thinking_signature && currentIndex !== -1) {
				const msg = messages[currentIndex];
				const sigArray = insertAtIndex(msg.thinking_signature, msgVersion, result.thinking_signature, '');
				setMessages(currentIndex, 'thinking_signature', sigArray);
			}

			if (result.success && currentIndex !== -1 && !(env.sendMode() === 'loop' && result.toolCalls))
				ui?.onStreamDone?.(getMessageContent(messages[currentIndex]));

			return result;
		} finally {
			contentDrip?.flush();
			reasoningDrip?.flush();
			setActiveStreams(prev => {
				const m = new Map(prev);
				const entries = (m.get(streamKey) || []).filter(e => e.versionIndex !== msgVersion);
				if (entries.length > 0) m.set(streamKey, entries); else m.delete(streamKey);
				return m;
			});
		}
	}

	async function sendAsideMessage(content: string) {
		if (isLoading()) return;

		if (!env.model()) {
			console.error('no model :(', env.model());
			env.setError("Please set a model")
			return;
		}

		abortAllStreams();

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
    
    Rewrite the above message "${content}"
    
    Output only the rewritten message, with no commentary.`;

		const rqstMsgs: Message[] = [{ role: 'user', content: rewritePrompt }];

		env.setError(null);

		await handleStreamingResponse(targetMessage, targetIndex, rqstMsgs);
	}

	return {
		messages, setMessages,
		sendMessage, sendAsideMessage, sendRewriteMessage,
		deleteMessage, setMessageContent,
		load, flush, invalidateWrites, discardPending, hasPendingWrites,
		enqueueWrite,
		version: () => chatVersion,
		abortAllStreams,
		isLoading: isLoading as Accessor<boolean>,
		activeStreams,
		chatConflict,
	};
}
