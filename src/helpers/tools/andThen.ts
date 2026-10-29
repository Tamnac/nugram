import type { ToolModule } from './types';

/**
 * Former sequential batch separator, replaced by `run` steps. No longer sent
 * or executed; registered in `toolModules` only so old chats render.
 */
export const andThenTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'and_then',
			description: 'Sequential step separator. Calls before and after it run in separate batches. After is skipped if any earlier call failed. Calls within a batch run in parallel. Use it to chain dependent steps whenever possible instead of ending your turn',
			parameters: {
				type: 'object',
				properties: {
					intent: {
						type: 'string',
						description: "What you've done or intent do to"
					}
				}
			}
		}
	},

	async execute() {
		return { ok: true };
	},

	format: () => 'ok',
};
