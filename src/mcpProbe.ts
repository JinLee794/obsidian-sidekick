/**
 * Direct MCP server probing — connects to MCP servers using the MCP protocol
 * to discover available tools via the `tools/list` method.
 *
 * Supports both stdio (local) and HTTP (remote) server types.
 * Servers matching known proxy-only patterns are skipped.
 */

import type {McpServerEntry, McpToolInfo} from './types';

const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;
declare const process: {
	platform: string;
	env: Record<string, string | undefined>;
};

/** Result of probing an MCP server. */
export interface McpProbeResult {
	serverName: string;
	tools: McpToolInfo[];
	error?: string;
	httpStatus?: number;
	/** True if the server was skipped (proxy-only). */
	skipped?: boolean;
}

// ── JSON-RPC helpers ────────────────────────────────────────────

let rpcId = 1;

function jsonRpcRequest(method: string, params?: Record<string, unknown>): string {
	return JSON.stringify({jsonrpc: '2.0', id: rpcId++, method, params: params ?? {}});
}

function jsonRpcNotification(method: string, params?: Record<string, unknown>): string {
	return JSON.stringify({jsonrpc: '2.0', method, params: params ?? {}});
}

// ── Proxy-only patterns ─────────────────────────────────────────

const PROXY_ONLY_PATTERNS: RegExp[] = [
	/agent365\.svc\.cloud\.microsoft/i,
];

export function isProxyOnlyServer(server: McpServerEntry): boolean {
	const url = server.config['url'] as string | undefined;
	if (!url) return false;
	return PROXY_ONLY_PATTERNS.some(p => p.test(url));
}

// ── Agency CLI proxy ────────────────────────────────────────────

/**
 * Whether the `agency` CLI binary is available on this machine.
 * Checked once and cached. Agency (https://aka.ms/agency) can proxy
 * agent365-hosted MCP servers locally with EntraID auth injection,
 * allowing us to treat them as regular stdio servers.
 */
let agencyCached: boolean | null = null;
/** Full resolved path to the agency binary (cached alongside availability). */
let agencyPath: string | null = null;

/** Build the PATH that includes the agency CLI install directory and common bin dirs. */
function buildAgencySearchPath(): string {
	const home = typeof process !== 'undefined' ? process.env['HOME'] || '' : '';
	const extraDirs = ['/usr/local/bin', '/opt/homebrew/bin'];
	if (home) {
		extraDirs.push(`${home}/.local/bin`);
		extraDirs.push(`${home}/.config/agency/CurrentVersion`);
	}
	return [...extraDirs, (typeof process !== 'undefined' ? process.env['PATH'] : '') || ''].join(':');
}

export function isAgencyAvailable(): boolean {
	// Pure cache read — priming must be done asynchronously via primeAgencyCache().
	// Returns false if not yet primed.
	return agencyCached === true;
}

/** Get the resolved full path to the agency binary, or 'agency' as fallback. */
export function getAgencyPath(): string {
	return agencyPath ?? 'agency';
}

/** Reset agency availability cache (e.g. after install). */
export function resetAgencyCache(): void {
	agencyCached = null;
	agencyPath = null;
	agencyServicesCache = null;
}

/**
 * Asynchronously prime the agency availability and service-discovery caches.
 * Call this once at startup (non-blocking). Subsequent sync calls to
 * `isAgencyAvailable()` and `discoverAgencyServers()` will return from cache.
 */
export async function primeAgencyCache(): Promise<void> {
	if (agencyCached !== null) return; // Already primed

	const cp = nodeRequire?.('node:child_process') as typeof import('node:child_process') | undefined;
	const fs = nodeRequire?.('node:fs') as typeof import('node:fs') | undefined;
	if (!cp || !fs) { agencyCached = false; agencyServicesCache = []; return; }

	// 1. Locate the binary (blocking fs.accessSync is < 1ms per dir — not a problem)
	const searchPath = buildAgencySearchPath();
	let resolved = '';
	for (const dir of searchPath.split(':')) {
		if (!dir) continue;
		const candidate = `${dir}/agency`;
		try { fs.accessSync(candidate, fs.constants.X_OK); resolved = candidate; break; } catch { /* skip */ }
	}
	if (!resolved) { agencyCached = false; agencyServicesCache = []; return; }
	agencyPath = resolved;

	// 2. Async verify it runs (non-blocking subprocess)
	try {
		await new Promise<void>((resolve, reject) => {
			cp.execFile(resolved, ['--version'], {timeout: 3_000, stdio: 'pipe'} as Parameters<typeof cp.execFile>[2], (err) => {
				if (err) reject(err); else resolve();
			});
		});
		agencyCached = true;
	} catch {
		agencyCached = false;
		agencyPath = null;
		agencyServicesCache = [];
		return;
	}

	// 3. Async service discovery
	try {
		const output = await new Promise<string>((resolve, reject) => {
			cp.execFile(resolved, ['mcp', '--help'], {timeout: 3_000, maxBuffer: 100 * 1024} as Parameters<typeof cp.execFile>[2], (err, stdout, stderr) => {
				// --help may exit with code 1 but still produce output
				if (err && !stdout && !stderr) reject(err);
				else resolve((stdout || '') + '\n' + (stderr || ''));
			});
		});
		agencyServicesCache = parseAgencyHelpOutput(resolved, output);
	} catch {
		agencyServicesCache = [];
	}
}

/**
 * Map of agent365 URL path segments → agency MCP subcommand names.
 * Used to prefer named subcommands (shorter, better UX in logs)
 * over the generic `agency mcp remote --url ...` fallback.
 */
const AGENCY_SERVICE_MAP: Record<string, string> = {
	mcp_MailTools: 'mail',
	mcp_CalendarTools: 'calendar',
	mcp_TeamsTools: 'teams',
	mcp_PlannerTools: 'planner',
	mcp_SharePointTools: 'sharepoint',
	mcp_WordTools: 'word',
	mcp_M365CopilotChat: 'm365-copilot',
	mcp_M365User: 'm365-user',
};

/**
 * For an agent365 proxy-only server, produce a rewritten McpServerEntry
 * that uses `agency mcp <service> --transport stdio` as a local stdio command.
 * If the URL doesn't match a known subcommand, falls back to
 * `agency mcp remote --url <url> --transport stdio`.
 */
export function rewriteForAgency(server: McpServerEntry): McpServerEntry {
	const url = server.config['url'] as string | undefined;
	if (!url) return server;

	// Try to extract the service name from the URL path
	const pathMatch = url.match(/\/servers\/(\w+)/);
	const serviceName = pathMatch ? AGENCY_SERVICE_MAP[pathMatch[1]!] : undefined;

	const args = serviceName
		? ['mcp', serviceName, '--transport', 'stdio']
		: ['mcp', 'remote', '--url', url, '--transport', 'stdio'];

	return {
		name: server.name,
		config: {
			command: getAgencyPath(),
			args,
		},
		...(server.auth ? {auth: server.auth} : {}),
	};
}

/**
 * Check if a server can be proxied via agency instead of being treated as proxy-only.
 */
export function canUseAgencyProxy(server: McpServerEntry): boolean {
	return isProxyOnlyServer(server) && isAgencyAvailable();
}

// ── Agency service discovery ────────────────────────────────────

/** Subcommands that are infrastructure, not user-facing MCP services. */
const AGENCY_INFRA_COMMANDS = new Set(['local', 'npx', 'remote', 'help']);

/** Cached agency service list (null = not yet checked, empty = checked but none). */
let agencyServicesCache: McpServerEntry[] | null = null;

/**
 * Discover named MCP services available through the `agency` CLI
 * by parsing `agency mcp --help`. Returns synthetic McpServerEntry objects
 * with `command: 'agency'` and `args: ['mcp', '<service>', '--transport', 'stdio']`.
 *
 * Results are cached for the lifetime of the process. Call `resetAgencyCache()`
 * to clear.
 */
export function discoverAgencyServers(): McpServerEntry[] {
	// Pure cache read — must call primeAgencyCache() first.
	// Returns empty array if cache has not been primed yet.
	return agencyServicesCache ?? [];
}

/** Parse the text output of `agency mcp --help` into McpServerEntry objects. */
function parseAgencyHelpOutput(fullPath: string, output: string): McpServerEntry[] {
	const entries: McpServerEntry[] = [];
	let inCommands = false;
	for (const line of output.split('\n')) {
		if (/^Commands:/.test(line)) { inCommands = true; continue; }
		if (/^Options:/.test(line) || (/^\S/.test(line) && inCommands && !/^\s/.test(line))) break;
		if (!inCommands) continue;
		const m = line.match(/^\s{2}(\S+)\s{2,}(.+)/);
		if (!m) continue;
		const cmd = m[1]!;
		const desc = m[2]!.trim();
		if (AGENCY_INFRA_COMMANDS.has(cmd)) continue;
		entries.push({
			name: `agency-${cmd}`,
			config: {
				command: fullPath,
				args: ['mcp', cmd, '--transport', 'stdio'],
				_agencyService: cmd,
				_agencyDescription: desc,
			},
		});
	}
	return entries;
}

/** Check if a server entry is an auto-discovered agency service. */
export function isAgencyService(server: McpServerEntry): boolean {
	return server.config['_agencyService'] !== undefined;
}

// ── Azure CLI auth ──────────────────────────────────────────────

/**
 * Map of URL host patterns → Azure resource URIs for `az account get-access-token`.
 * When an HTTP MCP server matches one of these and has no Authorization header,
 * we automatically fetch a token via the Azure CLI and inject it.
 *
 * Note: agent365.svc.cloud.microsoft is NOT here because the Azure CLI app is
 * not preauthorized for per-server execution scopes (McpServers.Mail.All etc).
 * Those servers require VS Code Copilot's OAuth client and are treated as proxy-only.
 *
 * Servers can override the resource via `"azureResource": "https://..."` in mcp.json.
 */
const AZURE_AUTH_PATTERNS: Array<{pattern: RegExp; resource: string}> = [
	{pattern: /api\.fabric\.microsoft\.com/i, resource: 'https://api.fabric.microsoft.com'},
];

/** Cached Azure CLI tokens keyed by resource URI. */
const azureTokenCache = new Map<string, {token: string; expiresOn: number}>();

/** Token refresh margin — refresh 5 minutes before expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Get the Azure resource URI a server URL requires, or undefined if not an Azure server. */
function getAzureResource(server: McpServerEntry): string | undefined {
	// Explicit override in server config takes priority
	const explicit = server.config['azureResource'] as string | undefined;
	if (explicit) return explicit;
	// Fall back to URL pattern matching
	const url = server.config['url'] as string | undefined;
	if (!url) return undefined;
	for (const {pattern, resource} of AZURE_AUTH_PATTERNS) {
		if (pattern.test(url)) return resource;
	}
	return undefined;
}

/** Check if a server already has an Authorization header set. */
function hasAuthHeader(server: McpServerEntry): boolean {
	const headers = server.config['headers'] as Record<string, string> | undefined;
	if (!headers) return false;
	return Object.keys(headers).some(k => k.toLowerCase() === 'authorization' && !!headers[k]);
}

/**
 * Fetch an Azure CLI access token for the given resource.
 * Returns the token string or undefined if `az` is not available.
 * Results are cached until near expiry.
 */
export async function getAzureToken(resource: string): Promise<string | undefined> {
	const cached = azureTokenCache.get(resource);
	if (cached && cached.expiresOn > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
		return cached.token;
	}

	const cp = nodeRequire?.('node:child_process') as typeof import('node:child_process') | undefined;
	const util = nodeRequire?.('node:util') as typeof import('node:util') | undefined;
	if (!cp || !util) return undefined;

	const execFileAsync = util.promisify(cp.execFile);

	const home = process.env['HOME'] || '';
	const extraDirs = ['/usr/local/bin', '/opt/homebrew/bin'];
	if (home) extraDirs.push(`${home}/.local/bin`);
	const searchPath = [...extraDirs, process.env['PATH'] || ''].join(':');

	try {
		const {stdout} = await execFileAsync('az', [
			'account', 'get-access-token',
			'--resource', resource,
			'--query', 'accessToken',
			'-o', 'tsv',
		], {timeout: 15_000, env: {...process.env, PATH: searchPath}});

		const token = stdout.trim();
		if (!token) return undefined;

		// Cache for ~1 hour (Azure CLI tokens are typically valid for 1h)
		azureTokenCache.set(resource, {
			token,
			expiresOn: Date.now() + 55 * 60 * 1000,
		});
		return token;
	} catch {
		return undefined;
	}
}

/**
 * Check if an MCP server needs Azure CLI auth (matches known Azure URL patterns
 * and has no Authorization header already set).
 */
export function needsAzureAuth(server: McpServerEntry): boolean {
	if (hasAuthHeader(server)) return false;
	return getAzureResource(server) !== undefined;
}

/**
 * Enrich MCP server entries with Azure CLI Bearer tokens.
 * For each HTTP server matching a known Azure URL pattern that lacks an
 * Authorization header, fetches a token via `az account get-access-token`
 * and injects it into the server's headers (in-memory only).
 *
 * Returns the set of server names that were enriched (for status tracking).
 */
export async function enrichServersWithAzureAuth(
	servers: McpServerEntry[],
	enabledNames?: Set<string>,
): Promise<Set<string>> {
	const enriched = new Set<string>();
	// Group servers by resource to minimize az CLI calls
	const byResource = new Map<string, McpServerEntry[]>();
	for (const server of servers) {
		if (enabledNames && !enabledNames.has(server.name)) continue;
		if (hasAuthHeader(server)) continue;
		const resource = getAzureResource(server);
		if (!resource) continue;
		let group = byResource.get(resource);
		if (!group) {
			group = [];
			byResource.set(resource, group);
		}
		group.push(server);
	}

	for (const [resource, group] of byResource) {
		const token = await getAzureToken(resource);
		if (!token) continue;
		for (const server of group) {
			const headers = (server.config['headers'] as Record<string, string> | undefined) ?? {};
			server.config['headers'] = {...headers, Authorization: `Bearer ${token}`};
			enriched.add(server.name);
		}
	}
	return enriched;
}

/** Clear cached Azure tokens (e.g. after sign-out or token refresh failure). */
export function clearAzureTokenCache(): void {
	azureTokenCache.clear();
}

// ── Stdio probe ─────────────────────────────────────────────────

async function probeStdioServer(server: McpServerEntry): Promise<McpProbeResult> {
	const cfg = server.config;
	const command = cfg['command'] as string;
	const args = (cfg['args'] as string[] | undefined) ?? [];
	const env = (cfg['env'] as Record<string, string> | undefined) ?? {};
	const cwd = cfg['cwd'] as string | undefined;

	const cp = nodeRequire?.('node:child_process') as typeof import('node:child_process') | undefined;
	if (!cp) return {serverName: server.name, tools: [], error: 'child_process not available'};

	const home = process.env['HOME'] || '';
	const extraDirs = ['/usr/local/bin', '/opt/homebrew/bin'];
	if (home) extraDirs.push(`${home}/.local/bin`);
	const searchPath = [...extraDirs, process.env['PATH'] || ''].join(':');

	return new Promise<McpProbeResult>((resolve) => {
		const timeout = 15_000;
		let settled = false;
		let buffer = '';

		const child = cp.spawn(command, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {...process.env, ...env, PATH: searchPath},
			...(cwd ? {cwd} : {}),
		});

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill('SIGKILL');
				resolve({serverName: server.name, tools: [], error: 'Timeout connecting to server'});
			}
		}, timeout);

		child.on('error', (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({serverName: server.name, tools: [], error: `Spawn error: ${err.message}`});
			}
		});

		child.on('exit', () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({serverName: server.name, tools: [], error: 'Server exited before responding'});
			}
		});

		let phase: 'init' | 'tools' | 'done' = 'init';

		child.stdout!.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf-8');
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('Content-Length')) continue;
				try {
					const msg = JSON.parse(trimmed);
					if (phase === 'init' && msg.result) {
						phase = 'tools';
						child.stdin!.write(jsonRpcNotification('notifications/initialized') + '\n');
						child.stdin!.write(jsonRpcRequest('tools/list') + '\n');
					} else if (phase === 'tools' && msg.result) {
						phase = 'done';
						const tools: McpToolInfo[] = (msg.result.tools || []).map((t: {name: string; description?: string}) => ({
							name: t.name,
							description: t.description || '',
						}));
						settled = true;
						clearTimeout(timer);
						child.stdin!.end();
						child.kill('SIGTERM');
						resolve({serverName: server.name, tools});
					} else if (msg.error) {
						settled = true;
						clearTimeout(timer);
						child.stdin!.end();
						child.kill('SIGTERM');
						resolve({serverName: server.name, tools: [], error: msg.error.message || 'RPC error'});
					}
				} catch {
					// Not valid JSON — skip
				}
			}
		});

		child.stdin!.write(jsonRpcRequest('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: {name: 'sidekick-probe', version: '1.0.0'},
		}) + '\n');
	});
}

// ── HTTP probe ──────────────────────────────────────────────────

async function probeHttpServer(server: McpServerEntry): Promise<McpProbeResult> {
	const cfg = server.config;
	const url = cfg['url'] as string;
	const headers = (cfg['headers'] as Record<string, string> | undefined) ?? {};

	try {
		const initResp = await fetch(url, {
			method: 'POST',
			headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers},
			body: jsonRpcRequest('initialize', {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: {name: 'sidekick-probe', version: '1.0.0'},
			}),
			signal: AbortSignal.timeout(10_000),
		});

		if (!initResp.ok) {
			return {serverName: server.name, tools: [], error: `HTTP ${initResp.status}: ${initResp.statusText}`, httpStatus: initResp.status};
		}

		const contentType = initResp.headers.get('content-type') || '';
		let sessionId: string | undefined;

		if (contentType.includes('text/event-stream')) {
			const text = await initResp.text();
			const initResult = parseSseJsonRpc(text);
			if (initResult?.error) {
				return {serverName: server.name, tools: [], error: initResult.error.message || 'Init error'};
			}
			sessionId = initResp.headers.get('mcp-session-id') || undefined;
		} else {
			const initJson = await initResp.json();
			if (initJson.error) {
				return {serverName: server.name, tools: [], error: initJson.error.message || 'Init error'};
			}
			sessionId = initResp.headers.get('mcp-session-id') || undefined;
		}

		const notifHeaders: Record<string, string> = {'Content-Type': 'application/json', ...headers};
		if (sessionId) notifHeaders['Mcp-Session-Id'] = sessionId;
		void fetch(url, {
			method: 'POST',
			headers: notifHeaders,
			body: jsonRpcNotification('notifications/initialized'),
			signal: AbortSignal.timeout(5_000),
		}).catch(() => {/* ignore */});

		const toolsHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...headers,
		};
		if (sessionId) toolsHeaders['Mcp-Session-Id'] = sessionId;

		const toolsResp = await fetch(url, {
			method: 'POST',
			headers: toolsHeaders,
			body: jsonRpcRequest('tools/list'),
			signal: AbortSignal.timeout(10_000),
		});

		if (!toolsResp.ok) {
			return {serverName: server.name, tools: [], error: `HTTP ${toolsResp.status} on tools/list`, httpStatus: toolsResp.status};
		}

		const toolsContentType = toolsResp.headers.get('content-type') || '';
		let toolsResult: {tools?: Array<{name: string; description?: string}>};

		if (toolsContentType.includes('text/event-stream')) {
			const text = await toolsResp.text();
			const parsed = parseSseJsonRpc(text);
			toolsResult = parsed?.result || {tools: []};
		} else {
			const toolsJson = await toolsResp.json();
			if (toolsJson.error) {
				return {serverName: server.name, tools: [], error: toolsJson.error.message || 'tools/list error'};
			}
			toolsResult = toolsJson.result || {tools: []};
		}

		const tools: McpToolInfo[] = (toolsResult.tools || []).map((t) => ({
			name: t.name,
			description: t.description || '',
		}));

		return {serverName: server.name, tools};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {serverName: server.name, tools: [], error: msg};
	}
}

function parseSseJsonRpc(sseText: string): {result?: Record<string, unknown>; error?: {message: string}} | null {
	for (const line of sseText.split('\n')) {
		if (line.startsWith('data: ')) {
			try { return JSON.parse(line.slice(6)); } catch { continue; }
		}
	}
	return null;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Probe a single MCP server to discover its tools.
 */
export async function probeMcpServer(server: McpServerEntry): Promise<McpProbeResult> {
	if (isProxyOnlyServer(server)) {
		// If agency CLI is available, proxy the agent365 server through it
		if (isAgencyAvailable()) {
			return probeStdioServer(rewriteForAgency(server));
		}
		return {serverName: server.name, tools: [], skipped: true};
	}
	const cfg = server.config;
	const serverType = cfg['type'] as string | undefined;
	if (serverType === 'http' || serverType === 'sse') return probeHttpServer(server);
	if (cfg['command']) return probeStdioServer(server);
	return {serverName: server.name, tools: [], error: 'Unknown server type'};
}

/**
 * Probe multiple MCP servers in parallel.
 */
export async function probeAllMcpServers(
	servers: McpServerEntry[],
	enabledNames: Set<string>,
): Promise<McpProbeResult[]> {
	const enabled = servers.filter(s => enabledNames.has(s.name));
	if (enabled.length === 0) return [];
	return Promise.all(enabled.map(s => probeMcpServer(s)));
}
