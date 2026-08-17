/**
 * Headless sub-agent runner (Phase 2 of SUBAGENTS_PLAN).
 *
 * `runAgentTask` executes a spawn_agent tool call: it creates a real chat
 * (visible/inspectable in the chat list), drives a headless ChatSession
 * through a bounded turn loop over a frozen snapshot of the parent's
 * environment, and returns the agent's final message as the tool result.
 * Never throws — all failures come back as result strings so the parent's
 * tool loop always completes.
 */
import { createSignal, type Setter } from 'solid-js';
import { unwrap } from 'solid-js/store';
import { createChatSession, type ChatSession, type SessionEnv } from './session';
import { createChat, saveChatMeta } from './db';
import { getMessageContent } from './messages';
import type { AgentPreset, AgentSettings, ChatMeta, Config, Provider } from './types';
import { tools } from './tools';

// ── Live-agent registry (Phase 3 UI reads this) ─────────────────────

const [runningAgents, setRunningAgents] = createSignal<Map<string, ChatSession>>(new Map());
export { runningAgents };

/** Live agents keyed by the spawn_agent tool call that started them (progress display in the parent chat). */
const [runningAgentsByCallId, setRunningAgentsByCallId] = createSignal<Map<string, { chatId: string; session: ChatSession }>>(new Map());
export { runningAgentsByCallId };

/** Abort controllers of live agents, keyed by parent chat id. */
const childAborts = new Map<string, Set<AbortController>>();

/**
 * Aborts every subagent spawned by parent chat.
 * Note: deleting a parent chat does NOT abort its subagents —
 * they outlive the parent and finish into their own (possibly detached) chat.
 */
export function abortAgentsFor(parentChatId: string) {
	for (const c of childAborts.get(parentChatId) ?? []) c.abort();
}

// ── Concurrency cap (N parallel streams to one provider key adds up) ────

const MAX_CONCURRENT_AGENTS = 3;
let activeCount = 0;
const waiters: (() => void)[] = [];
async function acquireSlot() {
	if (activeCount >= MAX_CONCURRENT_AGENTS)
		await new Promise<void>(resolve => waiters.push(resolve));
	activeCount++;
}
function releaseSlot() {
	activeCount--;
	waiters.shift()?.();
}

function formatElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// # Model / preset resolution ─────────────────────────────────────

const TIERS = ['lite', 'medium', 'ultra'] as const;
type Tier = typeof TIERS[number];

export function resolveAgentModel(
	args: { model?: string; preset?: string },
	settings: AgentSettings,
	parent: { model: string; provider: Provider }
): { model: string; provider: Provider; preset?: AgentPreset; prompt?: string } | { error: string } {
	let preset: AgentPreset | undefined;
	let modelArg = args.model;

	if (args.preset) {
		preset = settings.presets.find(p => p.name.toLowerCase() === args.preset!.toLowerCase());
		if (!preset) {
			const available = settings.presets.map(p => p.name).join(', ') || 'none';
			return { error: `Unknown preset "${args.preset}". Available presets: ${available}` };
		}
		modelArg = preset.model.trim() || 'self';
		// Explicit model id on the preset
		if (modelArg !== 'self' && !TIERS.includes(modelArg as Tier))
			return { model: modelArg, provider: preset.provider || parent.provider, preset };
	}

	if (!modelArg || modelArg === 'self')
		return { model: parent.model, provider: parent.provider, ...(preset && { preset }) };

	if (TIERS.includes(modelArg as Tier)) {
		const ref = settings.models[modelArg as Tier];
		if (!ref?.model.trim())
			return { error: `Model tier "${modelArg}" is not configured (set it in sidebar → Agents)` };
		return { model: ref.model.trim(), provider: ref.provider, ...(preset && { preset }), ...(ref.prompt?.trim() && { prompt: ref.prompt }) };
	}

	return { error: `Unknown model "${modelArg}". Use self, a configured tier (${TIERS.join('/')}) or a preset.` };
}

// # Agent runner ─────────────────────────────────────────────────

export interface SpawnAgentArgs {
	task?: string;
	model?: string;
	preset?: string;
	max_turns?: number;
}

export async function runAgentTask(opts: {
	args: SpawnAgentArgs;
	toolCallId?: string | undefined;
	parentChatId: string;
	parentEnv: SessionEnv;
	parentSession: ChatSession;
	settings: AgentSettings;
	onChatCreated?: (chatId: string) => void;
}): Promise<string> {
	const { args, parentEnv, settings } = opts;
	const task = args?.task?.trim();
	if (!task) return 'spawn_agent error: task is required';

	const resolved = resolveAgentModel(args, settings, { model: parentEnv.model(), provider: parentEnv.provider() });
	if ('error' in resolved) return `spawn_agent error: ${resolved.error}`;
	const { preset } = resolved;

	// fallback to 30 when unset
	const maxTurns = Math.max(args.max_turns ?? preset?.maxTurns ?? 30, 1);

	// Freeze subagent's env
	const providersSnap = parentEnv.providers();
	const optionsSnap = structuredClone(unwrap(parentEnv.options()));
	const configSnap = structuredClone(unwrap(parentEnv.activeConfig()));
	const tierPrompt = resolved.prompt?.trim() ?? '';
	const promptsSnap = preset?.prompt.trim()
		? [{ role: 'system' as const, content: preset.prompt, position: 0 }]
		: tierPrompt
			? [{ role: 'system' as const, content: tierPrompt, position: 0 }]
		: parentEnv.promptMessages();
	const cacheSnap = parentEnv.cache();
	const cacheLengthSnap = parentEnv.cacheLength();
	const macrosSnap = parentEnv.macros();
	const folderSnap = parentEnv.chatFolder();
	
	// Tool semantics: undefined record = all enabled; defined record = only `true`
	// entries. Materialize a full record so the two forced-off tools don't
	// accidentally disable everything when the base selection is undefined.
	const baseTools = preset?.tools ?? configSnap?.tools;
	const toolsSnap: Record<string, boolean> = Object.fromEntries(tools.map(t => [t.function.name, baseTools ? baseTools[t.function.name] === true : true]));
	toolsSnap.spawn_agent = false;
	toolsSnap.create_timer = false;
	// Agent's config = parent's config with the resolved tool set swapped in
	const agentConfigSnap: Config = { ...(configSnap ?? { name: '', prompts: [] }), tools: toolsSnap };

	// Register the abort controller before queueing for a slot, so a parent abort while we wait is not missed.
	const controller = new AbortController();
	let aborts = childAborts.get(opts.parentChatId);
	if (!aborts) childAborts.set(opts.parentChatId, aborts = new Set());
	aborts.add(controller);

	await acquireSlot();
	if (controller.signal.aborted) return '[Agent aborted while queued]';

	let chatId = '';
	try {
		const name = `Agent: ${preset ? `${preset.name} — ` : ''}${task.replace(/\s+/g, ' ').slice(0, 60)}`;

		// Nest under the spawning chat via parent_id (pointer link, no shared messages).
		chatId = await createChat(name, undefined, undefined, false, opts.parentChatId || undefined);

		const meta: Omit<ChatMeta, 'theme'> = {
			configName: configSnap?.name ?? '',
			macros: macrosSnap,
			cut: -1,
			tools: toolsSnap,
			model: resolved.model,
			provider: resolved.provider,
		};
		if (folderSnap) meta.chatFolder = folderSnap;
		await saveChatMeta(meta as ChatMeta, chatId);
		opts.onChatCreated?.(chatId);

		// ── Headless session over the frozen env ──
		let errorMsg: string | null = null;
		const env: SessionEnv = {
			chatId: () => chatId,
			model: () => resolved.model,
			provider: () => resolved.provider,
			providers: () => providersSnap,
			options: () => optionsSnap,
			activeConfig: () => agentConfigSnap,
			promptMessages: () => promptsSnap,
			cache: () => cacheSnap,
			cacheLength: () => cacheLengthSnap,
			macros: () => macrosSnap,
			chatFolder: () => folderSnap,
			cut: () => -1,
			sendMode: () => 'single', // instead of auto-looping, we manually loop till cap (below)
			lore: parentEnv.lore,
			setLore: parentEnv.setLore,
			// Shared global approval queue, tagged with this agent's chat name so the approval card says which agent is asking.
			requestPermission: (tc) => parentEnv.requestPermission(tc, name),
			shellSession: chatId,
			setError: ((v: any) => (errorMsg = typeof v === 'function' ? v(errorMsg) : v)) as Setter<string | null>,
			setInfo: (() => null) as Setter<string | null>,
			stream: parentEnv.stream,
		};

		const session = createChatSession(env);
		controller.signal.addEventListener('abort', () => session.abortAllStreams());

		session.load([], 0);

		setRunningAgents(prev => new Map(prev).set(chatId, session));
		if (opts.toolCallId) setRunningAgentsByCallId(prev => new Map(prev).set(opts.toolCallId!, { chatId, session }));

		// task = user message (headless sessions have no input)
		session.setMessages(session.messages.length, { role: 'user', content: [task], currentVersionIndex: 0 });

		// run to cap
		const startedAt = Date.now();
		let turns = 0;
		let capped = false;
		let truncated = false;
		while (!controller.signal.aborted) {
			if (turns >= maxTurns) { capped = true; break; }
			turns++;

			if (turns === maxTurns) {
				session.setMessages(session.messages.length, {
					role: 'user',
					content: ['You have hit the max turns. Provide your best final response now, even if the task is incomplete, noting incomplete parts. No more tool calls.'],
					currentVersionIndex: 0,
				});
			}

			const result = await session.sendMessage(turns === 1 ? undefined : -1, false);
			await session.flush(); // cheap; lets the user watch the chat read-only
			if (errorMsg) break;

			// Cut off by the output limit (often mid-thinking, leaving no content at all).
			// Ask for a continuation in a new message — many providers reject requests that
			// end on an assistant turn, so resuming the same message isn't an option.
			truncated = result?.finishReason === 'length';
			if (truncated) {
				session.setMessages(session.messages.length, {
					role: 'user',
					content: ['Your last message hit the output limit and was cut off. Continue from where you stopped.'],
					currentVersionIndex: 0,
				});
				continue;
			}

			const last = session.messages[session.messages.length - 1];
			const vi = last?.currentVersionIndex || 0;
			if (!(last?.role === 'assistant' && last.tool_calls?.[vi]?.length)) break;
		}

		await session.flush();

		// ── Summarize ──
		let cost = 0;
		for (const m of session.messages)
			for (const u of m.usage ?? [])
				cost += (u?.prompt_cost ?? 0) + (u?.message_cost ?? 0);

		// Last *substantive* assistant turn: a cap hit right after a cutoff leaves a
		// dangling continuation prompt, and a cut-off turn can be thinking-only.
		let finalContent = '';
		for (let i = session.messages.length - 1; i >= 0 && !finalContent; i--) {
			const m = session.messages[i];
			if (m.role === 'assistant') finalContent = getMessageContent(m).trim();
		}

		const status = controller.signal.aborted ? 'aborted'
			: errorMsg ? `failed: ${errorMsg}`
			: capped ? `hit the ${maxTurns}-turn cap${truncated ? ' while continuing a cut-off response' : ''} (result may be partial)`
			: truncated ? 'hit the output limit (result may be truncated)'
			: 'finished';
		const costStr = cost > 0 ? `, $${cost.toFixed(4)}` : '';
		return `[Agent ${status} — ${turns} turn${turns === 1 ? '' : 's'}, ${formatElapsed(Date.now() - startedAt)}${costStr}, chat "${name}"]\n\n${finalContent || '(no output)'}`;
	} catch (e) {
		return `spawn_agent error: ${e instanceof Error ? e.message : String(e)}`;
	} finally {
		releaseSlot();
		aborts.delete(controller);
		if (aborts.size === 0) childAborts.delete(opts.parentChatId);
		if (chatId) setRunningAgents(prev => { const m = new Map(prev); m.delete(chatId); return m; });
		if (opts.toolCallId) setRunningAgentsByCallId(prev => { const m = new Map(prev); m.delete(opts.toolCallId!); return m; });
	}
}
