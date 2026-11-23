import { test, expect, describe } from 'bun:test';
import { parseSshConfig } from '../src/helpers/backend/sshConfig';

const SAMPLE = `
Host *
  ServerAliveInterval 60
  User defaultuser

Host dev mydev
	Hostname dev.example.com
	User deploy
	Port 2222
	IdentityFile ~/.ssh/dev_key

Host wild-*.example.com
  User ignored
`;

describe('parseSshConfig', () => {
	const stanzas = parseSshConfig(SAMPLE);

	test('splits stanzas on Host lines, multiple names per stanza', () => {
		expect(stanzas.map(s => s.names)).toEqual([['*'], ['dev', 'mydev'], ['wild-*.example.com']]);
	});

	test('keeps known keys, drops unknown ones, first value per stanza wins', () => {
		expect(stanzas[1]!.opts).toEqual({
			hostname: 'dev.example.com', user: 'deploy', port: '2222', identityfile: '~/.ssh/dev_key',
		});
		expect(stanzas[0]!.opts['serveraliveinterval']).toBeUndefined();
	});

	test('handles Key=Value syntax and comments', () => {
		const s = parseSshConfig('Host box\n  HostName=box.internal # trailing comment\nPort = 2200\n');
		expect(s[0]!.opts).toEqual({ hostname: 'box.internal', port: '2200' });
	});

	test('options before the first Host are ignored', () => {
		expect(parseSshConfig('User orphan\nHost a\n  Port 22')).toEqual([{ names: ['a'], opts: { port: '22' } }]);
	});
});
