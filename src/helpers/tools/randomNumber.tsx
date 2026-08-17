import type { ToolModule } from './types';

export function randomInt(min: number = 1, max: number = 100): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const randomNumberTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'random_number',
			description: 'random number between min and max (inclusive)',
			parameters: {
				type: 'object',
				properties: {
					min: {
						type: 'integer',
						description: '1 if not specified'
					},
					max: {
						type: 'integer',
						description: '100 if not specified'
					}
				},
			}
		}
	},

	async execute(call) {
		const args = call.function.arguments as any;
		const min = args?.min ?? 1, max = args?.max ?? 100;
		if (min > max) throw new Error(`min (${min}) > max (${max})`);
		return { value: randomInt(min, max) };
	},

	format: data => `Random number: ${data.value}`,

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>roll <code>{args.min ?? 1}–{args.max ?? 100}</code></span>;
	},
};
