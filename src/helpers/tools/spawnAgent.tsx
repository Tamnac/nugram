import { isTauri } from '../platform';
import { thinkingParser, handleLinkClick } from '../markdown';
import type { Tool } from '../types';
import type { ToolModule } from './types';

const definition: Tool = {
	type: 'function',
	function: {
		name: 'spawn_agent',
		description: 'Spawn a subagent. It runs its own tool loop and returns its final answer. It has your tools unless its preset sets others. Multiple spawn_agent calls in one message run concurrently. Subagents cannot spawn further agents. Subagents only see this conversation if they read it with run_js `chat({ parent: true })`, so put what they need in `task`.',
		parameters: {
			type: 'object',
			properties: {
				task: {
					type: 'string',
					description: 'Task for the agent, sent to it as the user message'
				},
				model: {
					type: 'string',
					enum: ['self'],
					description: 'The model to use. Self (default) = same model as this chat.'
				},
				preset: {
					type: 'string',
					description: 'No presets configured by user — do not use, will be ignored.'
				},
				max_turns: {
					type: 'integer',
					description: 'Max agent turns'
				}
			},
			required: ['task']
		}
	}
};

type SpawnAgentPreset = { name: string; description?: string };

function setPresetSchema(props: any, presets: SpawnAgentPreset[]) {
	const namedPresets = presets.filter(p => p.name.trim());
	if (namedPresets.length > 0) {
		props.preset.enum = namedPresets.map(p => p.name);
		props.preset.description =
			'Run a preconfigured agent, which sets its own role, model, max_turns and system prompt. In `task`, give only what is specific to this task. Available presets:\n' +
			namedPresets.map(p => `- ${p.name}${p.description ? `: ${p.description}` : ''}`).join('\n');
	} else {
		delete props.preset.enum;
		props.preset.description = 'No presets configured — do not use.';
	}
}

/** A copy of the tool with these presets in its schema, so chats on different configs don't share preset enums. */
export function spawnAgentWithPresets(tool: Tool, presets: SpawnAgentPreset[]): Tool {
	const parameters = tool.function.parameters as any;
	const props = { ...parameters.properties, preset: { ...parameters.properties.preset } };
	setPresetSchema(props, presets);
	return { ...tool, function: { ...tool.function, parameters: { ...parameters, properties: props } } };
}

/**
 * Keeps the model enum in sync with the global tiers. Presets depend on the config,
 * so spawnAgentWithPresets applies them to a copy of the tool per request.
 * Has no effect on web, where spawn_agent is not sent.
 */
export function updateSpawnAgentTool(settings: {
	models: Record<'lite' | 'medium' | 'ultra', { model: string }>;
}, presets: SpawnAgentPreset[] = []) {
	const props = (definition.function.parameters as any).properties;

	const tiers = (['lite', 'medium', 'ultra'] as const).filter(t => settings.models[t]?.model.trim());
	props.model.enum = ['self', ...tiers];
	props.model.description = 'The model to use. The user assigns a model to each tier by capability and cost. Self (default) = same model as this chat.' +
		tiers.map(t => ` ${t} = ${settings.models[t].model.trim()}.`).join('');
	setPresetSchema(props, presets);
}

export const spawnAgentTool: ToolModule = {
	returns: "{ output: string (the agent's final answer) }",
	definition,
	available: isTauri,

	async execute(call, ctx) {
		if (!ctx.spawnAgent)
			return { ok: false, error: 'spawn_agent is not available here (desktop only; sub-agents cannot spawn further agents)' };
		try {
			return { output: await ctx.spawnAgent(call.function.arguments, call.id, ctx.chatMessages?.()) };
		} catch (error: any) {
			return { ok: false, error: `spawn_agent error: ${error?.message || error}` };
		}
	},

	format: data => data.output ?? '',

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>agent <code>{args.preset || args.model || 'self'}</code>{args.context === 'fork' ? ' · fork' : ''}</span>;
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		return (
			<div class='toolArgEdit'>
				<span style={{ opacity: '0.6' }}>{args.preset ? `preset ${args.preset}` : `model ${args.model || 'self'}`}{args.context === 'fork' ? ' · fork' : ''}{args.max_turns ? ` · max ${args.max_turns} turns` : ''}</span>
				{args.task ? <div class='toolArgContent' innerHTML={thinkingParser.render(args.task)} onClick={handleLinkClick} /> : null}
			</div>
		);
	},
};
