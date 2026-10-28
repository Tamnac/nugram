import { createEffect } from 'solid-js';
import { isTauri } from '../platform';
import { findWidget, mountWidget, parseWidgetHeight, rescanWidgets, widgetRegistry } from '../widgets';
import type { ToolModule } from './types';

export const showWidgetTool: ToolModule = {
	rerunnable: true,
	returns: '{ name: string, args?: object, height?: number }',
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
				},
				required: ['name'],
			},
		},
	},

	available: isTauri,

	async execute(call) {
		const { name, args, height } = (call.function.arguments ?? {}) as { name?: unknown; args?: unknown; height?: unknown };
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
		return { ok: true, name: widget.name, args: args ?? undefined, height: h };
	},

	format: data => `Showing widget ${data.name}`,

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>showed widget <code>{args?.name}</code></span>;
	},

	Inline: props => {
		let el!: HTMLDivElement;
		createEffect(() => {
			widgetRegistry();
			void mountWidget(el, props.data.name, props.data.args ?? {}, props.data.height);
		});
		return <div class='widgetInline' ref={el} />;
	},
};
