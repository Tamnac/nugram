import { isTauri } from '../platform';
import { thinkingParser, handleLinkClick } from '../markdown';
import type { Tool } from '../types';
import type { ToolModule } from './types';

const definition: Tool = {
	type: 'function',
	function: {
		name: 'spawn_agent',
		description: 'Spawn a sub-agent. runs its own tool loop and returns final answer. Runs as a separate chat session, inheriting your tools unless a preset says otherwise. Multiple spawn_agent calls in one message run concurrently. Sub-agents cannot spawn further agents.',
		parameters: {
			type: 'object',
			properties: {
				task: {
					type: 'string',
					description: 'Task for the agent, given to it as user prompt'
				},
				model: {
					type: 'string',
					enum: ['self'],
					description: 'self (default) = same model as this chat.'
				},
				preset: {
					type: 'string',
					description: 'No presets configured — do not use.'
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

/**
 * Rewrite the spawn_agent tool schema from the user's agent settings: the
 * `model` enum only offers configured tiers, and `preset` advertises the
 * user's presets. Mutates the shared tool object (same pattern as the shell
 * description patch). No-op in effect on web where spawn_agent isn't advertised.
 */
export function updateSpawnAgentTool(settings: {
	models: Record<'lite' | 'medium' | 'ultra', { model: string }>;
	presets: { name: string; description?: string }[];
}) {
	const props = (definition.function.parameters as any).properties;

	const tiers = (['lite', 'medium', 'ultra'] as const).filter(t => settings.models[t]?.model.trim());
	props.model.enum = ['self', ...tiers];
	props.model.description = 'self (default) = same model as this chat.' +
		tiers.map(t => ` ${t} = ${settings.models[t].model.trim()}.`).join('');

	const presets = settings.presets.filter(p => p.name.trim());
	if (presets.length > 0) {
		props.preset.enum = presets.map(p => p.name);
		props.preset.description =
			'Run a preconfigured agent, which includes a role, a model and prompt telling it how to behave. You need pass only a concise prompt with specifics/differences of your particular task. Available presets:\n' +
			presets.map(p => `- ${p.name}${p.description ? `: ${p.description}` : ''}`).join('\n');
	} else {
		delete props.preset.enum;
		props.preset.description = 'No presets configured — do not use.';
	}
}

export const spawnAgentTool: ToolModule = {
	definition,
	available: isTauri,

	async execute(call, ctx) {
		if (!ctx.spawnAgent)
			return { ok: false, error: 'spawn_agent is not available here (desktop only; sub-agents cannot spawn further agents)' };
		try {
			return { output: await ctx.spawnAgent(call.function.arguments, call.id) };
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
