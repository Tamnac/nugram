/* @refresh reload */
import { render } from 'solid-js/web';

import 'katex/dist/katex.min.css';
import './css/index.css';
import 'solid-devtools'
import App from './App';

declare global {
	var decode: (bytes: ArrayLike<number> | Uint8Array | string) => unknown;
}

function decode(bytes: ArrayLike<number> | Uint8Array | string): unknown {
	const value = typeof bytes === 'string' ? JSON.parse(bytes) : bytes;
	const decoded = new TextDecoder().decode(Uint8Array.from(value));
	return JSON.parse(decoded);
}

globalThis.decode = decode;

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
	throw new Error(
		'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?',
	);
}

render(() => <App />, root as HTMLElement);
