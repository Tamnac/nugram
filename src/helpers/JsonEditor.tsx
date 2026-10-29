import { createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { createMutable } from 'solid-js/store';
import { TSeg } from './Comps';
import { allowedKinds, childSchema, convertNode, defaultNode, freshKey, fromJson, isClosedObject, isContainer, isIntegerSchema, isValidNumberFor, newEntry, toJson, type JsonEntry, type JsonKind, type JsonNode, type JsonSchema } from './jsonTree';

const KIND_LABELS: Record<JsonKind, string> = { string: 'str', number: 'num', boolean: 'bool', null: 'null', object: '{ }', array: '[ ]' };

/**
 * Tree editor for a JSON object. Holds its own copy of `value` (read once), so `onChange` can feed
 * back into the parent without rebuilding the rows under the cursor. `onChange` is skipped while
 * a number is invalid. With a `schema`, properties and types follow it: an object that lists its
 * properties takes only those names, required ones stay, and fixed types and enums are not retyped.
 */
export function JsonEditor(props: { value: {}; onChange: (value: {}) => void; schema?: JsonSchema | undefined }) {
	const root = createMutable(fromJson(props.value));
	const emit = () => {
		try { props.onChange(toJson(root, props.schema) as {}); } catch { /* an invalid number keeps the last output */ }
	};
	return (
		<div class='jsonEditor'>
			<JsonChildren node={root} schema={props.schema} emit={emit} />
		</div>
	);
}

function JsonChildren(props: { node: JsonNode; schema: JsonSchema | undefined; emit: () => void }) {
	const closed = () => isClosedObject(props.node, props.schema);
	const missing = () => Object.keys(props.schema?.properties ?? {}).filter(name => !props.node.children.some(c => c.key === name));
	const addEntry = (key: string, schema: JsonSchema | undefined) => {
		props.node.children.push(newEntry(key, defaultNode(schema)));
		props.emit();
	};
	return (
		<div class='jsonChildren'>
			<For each={props.node.children}>
				{(entry, i) => <JsonRow parent={props.node} parentSchema={props.schema} entry={entry} index={i()} emit={props.emit} />}
			</For>
			<Show
				when={closed()}
				fallback={
					<button
						class='jsonAdd'
						title={props.node.kind === 'object' ? 'Add property' : 'Add item'}
						onClick={() => props.node.kind === 'object'
							? addEntry(freshKey(props.node), undefined)
							: addEntry('', props.schema?.items)}
					>+</button>
				}
			>
				<Show when={missing().length}>
					<select
						class='jsonAdd'
						title='Add property'
						onChange={e => {
							const name = e.currentTarget.value;
							e.currentTarget.value = '';
							if (name) addEntry(name, childSchema(props.schema, 'object', name));
						}}
					>
						<option value=''>+</option>
						<For each={missing()}>
							{name => <option value={name} title={props.schema?.properties?.[name]?.description}>{name}{props.schema?.required?.includes(name) ? ' *' : ''}</option>}
						</For>
					</select>
				</Show>
			</Show>
		</div>
	);
}

function JsonRow(props: { parent: JsonNode; parentSchema: JsonSchema | undefined; entry: JsonEntry; index: number; emit: () => void }) {
	const node = () => props.entry.node;
	const schema = () => childSchema(props.parentSchema, props.parent.kind, props.entry.key);
	const closed = () => isClosedObject(props.parent, props.parentSchema);
	const required = () => closed() && !!props.parentSchema?.required?.includes(props.entry.key);
	const kinds = () => {
		const allowed = allowedKinds(schema());
		return allowed.includes(node().kind) ? allowed : [...allowed, node().kind];
	};
	const remove = () => {
		props.parent.children = props.parent.children.filter(c => c.id !== props.entry.id);
		props.emit();
	};
	const setKind = (kind: JsonKind) => {
		convertNode(node(), kind);
		props.emit();
	};
	const setText = (text: string) => {
		node().text = text;
		props.emit();
	};
	return (
		<div class='jsonRow'>
			<div class='jsonLine'>
				<Show when={isContainer(node())} fallback={<span class='jsonToggle' />}>
					<button class='jsonToggle' title={node().open ? 'Collapse' : 'Expand'} onClick={() => node().open = !node().open}>
						{node().open ? '▾' : '▸'}
					</button>
				</Show>
				<Show when={props.parent.kind === 'object'} fallback={<span class='jsonIndex'>{props.index}</span>}>
					<Show
						when={closed()}
						fallback={
							<input
								class='jsonKey'
								value={props.entry.key}
								spellcheck={false}
								onInput={e => { props.entry.key = e.currentTarget.value; props.emit(); }}
							/>
						}
					>
						<span
							class={`jsonKey jsonKeyFixed ${schema() ? '' : 'unknown'}`}
							title={schema() ? schema()!.description : 'Not in the tool schema'}
						>
							{props.entry.key}{required() ? ' *' : ''}
						</span>
					</Show>
				</Show>
				<span class='jsonColon'>:</span>
				<Show when={kinds().length > 1} fallback={<span class='jsonKind fixed'>{KIND_LABELS[node().kind]}</span>}>
					<select class='jsonKind' value={node().kind} onChange={e => setKind(e.currentTarget.value as JsonKind)}>
						<For each={kinds()}>{kind => <option value={kind} selected={kind === node().kind}>{KIND_LABELS[kind]}</option>}</For>
					</select>
				</Show>
				<JsonValue node={node()} schema={schema()} setText={setText} />
				<Show when={!required()}>
					<button class='jsonRemove' title='Remove' onClick={remove}>×</button>
				</Show>
			</div>
			<Show when={isContainer(node()) && node().open}>
				<JsonChildren node={node()} schema={schema()} emit={props.emit} />
			</Show>
		</div>
	);
}

function JsonValue(props: { node: JsonNode; schema: JsonSchema | undefined; setText: (text: string) => void }) {
	const options = () => props.node.kind === 'string' || props.node.kind === 'number' ? props.schema?.enum?.map(String) : undefined;
	return (<>
		<Show when={options()}>
			{values => (
				<select class='jsonText' value={props.node.text} onChange={e => props.setText(e.currentTarget.value)}>
					<For each={values().includes(props.node.text) ? values() : [props.node.text, ...values()]}>
						{value => <option value={value} selected={value === props.node.text}>{value}</option>}
					</For>
				</select>
			)}
		</Show>
		<Show when={!options() && props.node.kind === 'string'}>
			<textarea
				class='jsonText'
				rows={1}
				value={props.node.text}
				spellcheck={false}
				onInput={e => props.setText(e.currentTarget.value)}
			/>
		</Show>
		<Show when={!options() && props.node.kind === 'number'}>
			<input
				class={`jsonText ${isValidNumberFor(props.node.text, props.schema) ? '' : 'invalid'}`}
				value={props.node.text}
				inputMode={isIntegerSchema(props.schema) ? 'numeric' : 'decimal'}
				spellcheck={false}
				onInput={e => props.setText(e.currentTarget.value)}
			/>
		</Show>
		<Show when={props.node.kind === 'boolean'}>
			<label class='jsonBool'>
				<input type='checkbox' checked={props.node.text === 'true'} onChange={e => props.setText(String(e.currentTarget.checked))} />
				{props.node.text}
			</label>
		</Show>
		<Show when={isContainer(props.node) && !props.node.open}>
			<span class='jsonSummary'>{props.node.children.length} {props.node.kind === 'object' ? 'keys' : 'items'}</span>
		</Show>
	</>);
}

/**
 * A JSON object kept as text, edited as a tree or as raw text. Opens as a tree when the text is an
 * object (or empty); text that is not valid can only be fixed in text mode.
 */
export function JsonField(props: { text: string; onChange: (text: string) => void; schema?: JsonSchema | undefined; textClass?: string; placeholder?: string; rows?: number }) {
	const parsed = createMemo((): {} | undefined => {
		if (!props.text.trim()) return {};
		try {
			const value = JSON.parse(props.text);
			return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
		} catch {
			return undefined;
		}
	});
	const [tree, setTree] = createSignal(parsed() !== undefined);
	return (
		<div class='jsonField'>
			<TSeg
				options={{ tree: 'Tree', text: 'Text' }}
				selected={tree() ? 'tree' : 'text'}
				setSelected={mode => setTree(mode === 'tree' && parsed() !== undefined)}
				tooltips={{ tree: 'Edit as a tree', text: 'Edit as raw JSON' }}
			/>
			<Show
				when={tree()}
				fallback={
					<textarea
						class={props.textClass}
						placeholder={props.placeholder}
						value={props.text}
						onInput={e => props.onChange(e.currentTarget.value)}
						rows={props.rows}
						spellcheck={false}
					/>
				}
			>
				<JsonEditor value={untrack(parsed)!} schema={props.schema} onChange={value => props.onChange(JSON.stringify(value, null, 2))} />
			</Show>
		</div>
	);
}
