import { createEffect, useContext } from 'solid-js';
import { isTauri } from '../platform';
import { findWidget, generateWidgetId, mountWidget, parseWidgetHeight, rescanWidgets, WidgetHostContext, widgetRegistry } from '../widgets';
import type { ToolModule } from './types';

/** Ids handed out by calls that haven't stored a result yet, so calls running together get different ones. By call id. */
const claimed = new Map<string, { chatId: string | undefined; id: string }>();

const optionalString = (value: unknown) => typeof value === 'string' && value ? value : undefined;

export const showWidgetTool: ToolModule = {
	rerunnable: true,
	returns: '{ name: string, id?: string, args?: object, height?: number, inherit?: string, state?: "copy" | "fresh" }',
	definition: {
		type: 'function',
		function: {
			name: 'show_widget',
			description: 'Show one of the available widgets (see the <widgets> list) inline in chat',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Widget name' },
					args: { type: 'object', description: 'Passed to the widget as `window.widgetArgs`' },
					height: { type: 'integer', description: 'Height in pixels. Default 400. The user can resize it' },
					id: { type: 'string', description: 'Name this instance, unique in the chat. Its saved state is kept under it. Default: generated, and shown in the result' },
					inherit: { type: 'string', description: 'Id of an earlier instance to start from: this one begins with a copy of its saved state. Args are not inherited, pass them again' },
					state: { type: 'string', enum: ['copy', 'fresh'], description: 'With inherit: `copy` (default) copies the saved state, `fresh` starts without it' },
				},
				required: ['name'],
			},
		},
	},

	available: isTauri,

	async execute(call, ctx) {
		const { name, args, height, id, inherit, state } = (call.function.arguments ?? {}) as Record<string, unknown>;
		if (typeof name !== 'string' || !name) return { ok: false, error: 'show_widget needs a widget `name`' };
		let widget = findWidget(name);
		if (!widget) {
			// The model may have just written it
			await rescanWidgets();
			widget = findWidget(name);
		}
		if (!widget) {
			const available = widgetRegistry().widgets.map(w => w.name).join(', ') || 'none';
			return { ok: false, error: `Unknown widget "${name}". Available: ${available}` };
		}
		if (args != null && (typeof args !== 'object' || Array.isArray(args)))
			return { ok: false, error: '`args` must be an object' };
		const h = parseWidgetHeight(height);
		if (height != null && h === undefined)
			return { ok: false, error: `\`height\` must be a positive number of pixels, got ${JSON.stringify(height)}` };
		if (state != null && state !== 'copy' && state !== 'fresh')
			return { ok: false, error: `\`state\` must be "copy" or "fresh", got ${JSON.stringify(state)}` };

		const used = new Set(ctx.usedWidgetIds?.());
		for (const [callId, claim] of claimed)
			if (callId !== call.id && claim.chatId === ctx.chatId) used.add(claim.id);
		let instanceId = optionalString(id);
		if (instanceId && used.has(instanceId))
			return { ok: false, error: `Widget id "${instanceId}" is already used in this chat. Pass another, or omit \`id\` to get one generated` };
		instanceId ??= optionalString(ctx.previous?.id) ?? generateWidgetId(widget.name, used);
		const inheritId = optionalString(inherit);
		if (inheritId && !used.has(inheritId))
			return { ok: false, error: `Cannot inherit from "${inheritId}": no widget with that id in this chat` };
		claimed.set(call.id, { chatId: ctx.chatId, id: instanceId });

		return { ok: true, name: widget.name, id: instanceId, args: args ?? undefined, height: h, inherit: inheritId, state: inheritId ? state ?? undefined : undefined };
	},

	format: data => `Showing widget ${data.name}${data.id ? ` (id: ${data.id})` : ''}`,

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>showed widget <code>{args?.name}</code></span>;
	},

	Inline: props => {
		let el!: HTMLDivElement;
		const host = useContext(WidgetHostContext);
		createEffect(() => {
			widgetRegistry();
			const { name, args, height, id, inherit, state } = props.data;
			void mountWidget(el, { name, args: args ?? {}, height, id, inherit, state, host });
		});
		return <div class='widgetInline' ref={el} />;
	},
};
