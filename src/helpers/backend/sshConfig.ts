/**
 * ~/.ssh/config parsing and host alias resolution. Deliberately TS-side so the
 * behavior is easy to tweak — only the wire protocol lives in Rust
 * (src-tauri/src/ssh.rs).
 */
import type { SshBackendConfig } from '../types';
import { localBackend } from './local';

/** A concrete Host entry from ~/.ssh/config, offered as a pickable alias. */
export interface DiscoveredHost {
	alias: string;
	hostname?: string | undefined;
	user?: string | undefined;
	port?: number | undefined;
	keyPath?: string | undefined;
}

/** What Rust's SshConfig expects: everything already resolved. */
export interface ResolvedSshConfig {
	id: string;
	host: string;
	port: number;
	user?: string | undefined;
	keyPath?: string | undefined;
	keyPassphrase?: string | undefined;
	password?: string | undefined;
}

interface Stanza {
	names: string[];
	opts: Record<string, string>;
}

const KNOWN_KEYS = new Set(['hostname', 'port', 'user', 'identityfile']);

/** Minimal parser: Host stanzas with exact names or '*'. Match blocks, Include
 *  directives and %h/%d tokens are out of scope. */
export function parseSshConfig(text: string): Stanza[] {
	const stanzas: Stanza[] = [];
	let current: Stanza | null = null;
	for (const raw of text.split('\n')) {
		const line = (raw.split('#')[0] ?? '').trim();
		const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
		if (!m || !m[2]) continue;
		const key = m[1]!.toLowerCase();
		const value = m[2].trim();
		if (!value) continue;
		if (key === 'host') {
			current = { names: value.split(/\s+/), opts: {} };
			stanzas.push(current);
		} else if (current && KNOWN_KEYS.has(key) && !(key in current.opts)) {
			current.opts[key] = value;
		}
	}
	return stanzas;
}

/** Merged options for an alias: exact-name and '*' stanzas, first value per
 *  option wins in file order (matching OpenSSH). */
function optsFor(stanzas: Stanza[], alias: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const s of stanzas) {
		if (!s.names.some(n => n === alias || n === '*')) continue;
		for (const [k, v] of Object.entries(s.opts)) if (!(k in out)) out[k] = v;
	}
	return out;
}

async function readConfigFile(): Promise<{ home: string, stanzas: Stanza[] } | null> {
	try {
		const home = await localBackend.homeDir();
		const sep = localBackend.paths.sep;
		const text = await localBackend.readText(`${home}${sep}.ssh${sep}config`);
		return { home, stanzas: parseSshConfig(text) };
	} catch {
		return null; // no file, or not Tauri: resolution just skips the config
	}
}

/** Concrete (non-wildcard) Host aliases, for sidebar suggestions. */
export async function listSshConfigHosts(): Promise<DiscoveredHost[]> {
	const conf = await readConfigFile();
	if (!conf) return [];
	const seen = new Set<string>();
	const out: DiscoveredHost[] = [];
	for (const s of conf.stanzas) {
		for (const alias of s.names) {
			if (alias.includes('*') || alias.includes('?') || seen.has(alias)) continue;
			seen.add(alias);
			const opts = optsFor(conf.stanzas, alias);
			out.push({
				alias,
				hostname: opts['hostname'],
				user: opts['user'],
				port: opts['port'] ? parseInt(opts['port']) || undefined : undefined,
				keyPath: opts['identityfile'],
			});
		}
	}
	return out;
}

/** Resolve a user-facing backend config (`user@host:port`, ssh-config aliases)
 *  into the flat shape Rust connects with. */
export async function resolveSshBackend(cfg: SshBackendConfig): Promise<ResolvedSshConfig> {
	let hostport = cfg.host.trim();
	if (!hostport) throw new Error(`SSH backend "${cfg.label || cfg.id}" has no host`);

	let user = cfg.user;
	const at = hostport.lastIndexOf('@');
	if (at >= 0) {
		user ||= hostport.slice(0, at) || undefined;
		hostport = hostport.slice(at + 1);
	}
	let alias = hostport;
	let port = cfg.port;
	const colon = hostport.lastIndexOf(':');
	if (colon > 0 && /^\d+$/.test(hostport.slice(colon + 1))) {
		alias = hostport.slice(0, colon);
		port ??= parseInt(hostport.slice(colon + 1));
	}

	const conf = await readConfigFile();
	const opts = conf ? optsFor(conf.stanzas, alias) : {};
	const expandTilde = (p: string | undefined) =>
		p && p.startsWith('~/') && conf ? conf.home + localBackend.paths.sep + p.slice(2) : p;

	return {
		id: cfg.id,
		host: opts['hostname'] || alias,
		port: port ?? (opts['port'] ? parseInt(opts['port']) || 22 : 22),
		user: user || opts['user'] || undefined,
		keyPath: cfg.keyPath ? expandTilde(cfg.keyPath) : expandTilde(opts['identityfile']),
		keyPassphrase: cfg.keyPassphrase,
		password: cfg.password,
	};
}
