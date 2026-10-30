import { For } from 'solid-js';
import { isTauri } from '../platform';
import { FileContent, formatFileContent, readFileData, type FileContentData } from '../fileContent';
import { attachImage, storeImageOriginal } from '../attachments';
import { ChatImage } from '../Comps';
import type { Tool } from '../types';
import { imageCropMode } from '../imageCrop';
import type { ToolModule } from './types';

const definition: Tool = {
	type: 'function',
	function: {
		name: 'read_file',
		description: 'Read a file from the filesystem. Images (png/jpg/gif/webp/bmp/avif) come back as pictures you can look at; everything else must be text. Paths are relative to the chat\'s working folder if set, otherwise must be absolute. Output includes line numbers for reference (not part of the file content).',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'File path (relative to chat folder, or absolute)'
				},
				range: {
					type: 'string',
					description: 'Optional line range as "start:end". Either side can be omitted for open-ended. Negative indices count from end. Examples: "5:15", "10:", ":20", "-50:"'
				}
			},
			required: ['path']
		}
	}
};

function cropDescription(model: string | undefined): string {
	return imageCropMode(model) === 'pixels'
		? 'Optional image crop with top-left and bottom-right pixel coordinates. Use the image dimensions reported by the previous read_file result, which may differ from dimensions on disk.'
		: 'Optional image crop with top-left and bottom-right coordinates normalized to a 0-1000 grid, where (0,0) is top-left and (1000,1000) is bottom-right.';
}

function formatImageContent(data: any): string {
	const size = data.viewSize?.width !== undefined && data.viewSize?.height !== undefined
		? `, ${data.crop ? 'source view dimensions' : 'image dimensions'} ${data.viewSize.width}x${data.viewSize.height}` : '';
	const crop = data.crop && data.outputSize?.width !== undefined && data.outputSize?.height !== undefined
		? `, crop ${data.crop.x1},${data.crop.y1}:${data.crop.x2},${data.crop.y2}, returned image dimensions ${data.outputSize.width}x${data.outputSize.height}` : '';
	return `${data.path} (image, ${Math.round((data.bytes ?? 0) / 1024)} KB${size}${crop})`;
}

export const readFileTool: ToolModule = {
	returns: 'text: { path: string, body: string (without line numbers), start: number, end: number, total: number, truncated?: true } (body holds lines start+1..end of total); '
		+ 'image: { path: string, bytes: number, sourceSize: { width, height } } (the picture itself reaches you from a direct call, or when run_js returns the reply)',
	definition,
	describe: (_backend, model) => {
		const parameters = definition.function.parameters as any;
		return {
			...definition,
			function: {
				...definition.function,
				parameters: {
					...parameters,
					properties: {
						...parameters.properties,
						crop: {
							type: 'object',
							description: cropDescription(model),
							properties: {
								x1: { type: 'number', description: 'Left edge' },
								y1: { type: 'number', description: 'Top edge' },
								x2: { type: 'number', description: 'Right edge' },
								y2: { type: 'number', description: 'Bottom edge' },
							},
							required: ['x1', 'y1', 'x2', 'y2'],
						}
					}
				}
			}
		};
	},
	available: isTauri,

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		return readFileData(args, ctx.chatFolder, attachImage, ctx.backend, ctx.model, storeImageOriginal);
	},

	format: data => data.images ? formatImageContent(data) : formatFileContent(data as FileContentData),

	Summary: props => {
		const args = props.call.function.arguments as any;
		const crop = args.crop && typeof args.crop === 'object' && !Array.isArray(args.crop)
			? ` ${args.crop.x1},${args.crop.y1}:${args.crop.x2},${args.crop.y2}`
			: args.crop ? ` ${String(args.crop)}` : '';
		return <span>read <code>{args.path}{args.range ? ' ' + args.range : ''}{crop}</code></span>;
	},

	Result: props => props.data.images
		? (
			<div class='toolResultContent'>
				<div style={{ opacity: '0.6', 'margin-bottom': '4px' }}>{formatImageContent(props.data)}</div>
				<div class='imageStrip'>
					<For each={props.data.images as string[]}>{(id: string, i) => <ChatImage src={id} label={(props.data.images as string[]).length > 1 ? `Image ${i() + 1}` : undefined} />}</For>
				</div>
			</div>
		)
		: <FileContent data={props.data as FileContentData} />,

	LegacyResult: props => {
		const newline = () => props.content.indexOf('\n');
		const header = () => newline() > -1 ? props.content.slice(0, newline()) : props.content;
		const body = () => newline() > -1 ? props.content.slice(newline() + 1).replace(/^\n/, '') : '';
		return (
			<div class='toolResultContent'>
				<div style={{ opacity: '0.6', 'margin-bottom': '4px' }}>{header()}</div>
				<pre class='toolScroll' style={{ margin: '0', 'white-space': 'pre-wrap', 'word-break': 'break-all' }}>{body().replace(/^\d+\u2502/gm, '')}</pre>
			</div>
		);
	},
};
