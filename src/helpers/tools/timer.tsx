import type { ToolModule } from './types';

export const createTimerTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'create_timer',
			description: 'Create a countdown timer that starts on click, beeps when finished',
			parameters: {
				type: 'object',
				properties: {
					seconds: {
						type: 'integer',
						description: 'Duration in seconds. 60 if not specified'
					}
				},
			}
		}
	},

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		const seconds = args?.seconds || 60;
		if (ctx.timers) {
			ctx.timers.setReady(true);
			ctx.timers.setDuration(seconds);
			ctx.timers.setRemaining(seconds);
			ctx.timers.setActive(true); // Show the timer display
		}
		return { seconds };
	},

	format: data => `Timer ready for ${data.seconds} seconds - tell user to click to start`,

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>created a <code>{args.seconds ?? 60}s</code> timer</span>;
	},
};
