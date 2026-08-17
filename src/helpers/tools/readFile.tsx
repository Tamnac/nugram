import { For } from 'solid-js';
import { isTauri } from '../platform';
import { FileContent, formatFileContent, readFileData, type FileContentData } from '../fileContent';
import { attachImage } from '../attachments';
import { ChatImage } from '../Comps';
import type { ToolModule } from './types';

export const readFileTool: ToolModule = {
	definition: {
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
	},
	available: isTauri,

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		return readFileData(args, ctx.chatFolder, attachImage);
	},

	format: data => {
		if (data.images) return `${data.path} (image, ${Math.round((data.bytes ?? 0) / 1024)} KB)`;
		return formatFileContent(data as FileContentData);
	},

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>read <code>{args.path}{args.range ? ' ' + args.range : ''}</code></span>;
	},

	Result: props => props.data.images
		? (
			<div class='toolResultContent'>
				<div style={{ opacity: '0.6', 'margin-bottom': '4px' }}>{props.data.path}</div>
				<div class='imageStrip'>
					<For each={props.data.images as string[]}>{(id: string) => <ChatImage src={id} />}</For>
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
				<pre style={{ margin: '0', 'white-space': 'pre-wrap', 'word-break': 'break-all' }}>{body().replace(/^\d+\u2502/gm, '')}</pre>
			</div>
		);
	},
};
