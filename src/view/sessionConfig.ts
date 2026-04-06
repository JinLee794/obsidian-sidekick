import {normalizePath, TFile, TFolder} from 'obsidian';
import type {App} from 'obsidian';
import type {MCPServerConfig, ModelInfo, MessageOptions, ProviderConfig, SessionConfig, ReasoningEffort, PermissionRequest, CustomAgentConfig, Tool} from '../copilot';
import {approveAll, defineTool} from '../copilot';
import type {AgentConfig, McpServerEntry, ChatAttachment} from '../types';
import type {SidekickView} from '../sidekickView';
import {getSkillsFolder, getAgentsFolder as getAgentsFolderSetting} from '../settings';
import {resolveEnvRef} from '../secureStorage';
import {ToolApprovalModal} from '../modals/toolApprovalModal';
import {UserInputModal} from '../modals/userInputModal';
import type {UserInputRequest} from '../modals/userInputModal';
import {isProxyOnlyServer, isAgencyAvailable, rewriteForAgency} from '../mcpProbe';
import {debugTrace} from '../debug';
import type {VaultIndex} from '../vaultIndex';

/**
 * Map MCP server entries to MCPServerConfig objects, filtering by enabled set.
 *
 * Proxy-only servers (e.g. agent365 M365 servers) are normally excluded — they
 * require the Copilot CLI's own OAuth flow. However, when the `agency` CLI is
 * detected, these servers are transparently proxied through it as local stdio
 * servers, with EntraID auth handled by agency.
 */
export function mapMcpServers(mcpServers: McpServerEntry[], enabledMcpServers: Set<string>): Record<string, MCPServerConfig> {
	const result: Record<string, MCPServerConfig> = {};
	const hasAgency = isAgencyAvailable();
	for (const server of mcpServers) {
		if (!enabledMcpServers.has(server.name)) continue;

		// Proxy-only servers: route through agency if available, skip otherwise
		if (isProxyOnlyServer(server)) {
			if (!hasAgency) continue;
			const rewritten = rewriteForAgency(server);
			const args = (rewritten.config['args'] as string[] | undefined) ?? [];
			debugTrace(`Agency proxy for ${server.name}: agency ${args.join(' ')}`);
			result[server.name] = {
				type: 'local',
				command: rewritten.config['command'] as string,
				args,
				tools: (server.config['tools'] as string[] | undefined) ?? ['*'],
			} as MCPServerConfig;
			continue;
		}
		const cfg = server.config;
		const serverType = cfg['type'] as string | undefined;
		const tools = (cfg['tools'] as string[] | undefined) ?? ['*'];

		// Only pass headers when they contain actual entries.
		// Empty headers {} can prevent the Copilot CLI from using its own
		// auth mechanism (MCP OAuth, GitHub SSO) for known services.
		const rawHeaders = cfg['headers'] as Record<string, string> | undefined;
		const hasHeaders = rawHeaders && Object.keys(rawHeaders).length > 0;

		if (serverType === 'http' || serverType === 'sse') {
			result[server.name] = {
				type: serverType,
				url: cfg['url'] as string,
				tools,
				...(hasHeaders ? {headers: rawHeaders} : {}),
				...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
			} as MCPServerConfig;
		} else if (cfg['command']) {
			result[server.name] = {
				type: 'local',
				command: cfg['command'] as string,
				args: (cfg['args'] as string[] | undefined) ?? [],
				tools,
				...(cfg['env'] ? {env: cfg['env'] as Record<string, string>} : {}),
				...(cfg['cwd'] ? {cwd: cfg['cwd'] as string} : {}),
				...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
			} as MCPServerConfig;
		}
	}
	return result;
}

/**
 * Resolve a model ID from an agent's preferred model name / partial match.
 * Returns the matching model ID, or `fallback` if no match is found.
 */
export function resolveModelForAgent(agent: AgentConfig | undefined, models: ModelInfo[], fallback: string | undefined): string | undefined {
	if (!agent?.model) return fallback;
	const target = agent.model.toLowerCase();
	let match = models.find(
		m => m.name.toLowerCase() === target || m.id.toLowerCase() === target
	);
	if (!match) {
		match = models.find(
			m => m.id.toLowerCase().includes(target) || m.name.toLowerCase().includes(target)
		);
	}
	return match ? match.id : fallback;
}

/**
 * Build the user prompt, inlining clipboard content, selection text, and cursor position.
 */
export function buildPrompt(
	basePrompt: string,
	attachments: ChatAttachment[],
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null,
	activeSelection: {filePath: string; text: string} | null,
): string {
	let prompt = basePrompt;
	const clipboards = attachments.filter(a => a.type === 'clipboard');
	for (const clip of clipboards) {
		if (clip.content) {
			prompt += `\n\n---\nClipboard content:\n${clip.content}`;
		}
	}
	// Inline selection text in the prompt because the Copilot CLI server's
	// session.send handler normalises all attachments to {type, path, displayName},
	// stripping the selection-specific fields (filePath, text, selection range).
	const selections = attachments.filter(a => a.type === 'selection');
	for (const sel of selections) {
		if (sel.content) {
			const range = sel.selection
				? sel.selection.startLine === sel.selection.endLine
					? `line ${sel.selection.startLine}`
					: `lines ${sel.selection.startLine}-${sel.selection.endLine}`
				: '';
			const header = sel.path
				? `Selected text from ${sel.path}${range ? ` (${range})` : ''}`
				: 'Selected text';
			prompt += `\n\n---\n${header}:\n${sel.content}`;
		}
	}
	// Include cursor position so the model knows where the user's cursor is
	if (cursorPosition && !activeSelection) {
		prompt += `\n\n---\nCurrent cursor position: ${cursorPosition.filePath}, line ${cursorPosition.line}, column ${cursorPosition.ch}`;
	}
	return prompt;
}

/**
 * Build SDK-compatible attachments array from ChatAttachment items and scope paths.
 */
export function buildSdkAttachments(params: {
	attachments: ChatAttachment[];
	scopePaths: string[];
	vaultBasePath: string;
	app: App;
}): MessageOptions['attachments'] {
	const {attachments, scopePaths, vaultBasePath, app} = params;
	const result: NonNullable<MessageOptions['attachments']> = [];

	for (const att of attachments) {
		if ((att.type === 'file' || att.type === 'image') && att.path) {
			const filePath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'file',
				path: filePath,
				displayName: att.name,
			});
		} else if (att.type === 'selection' && att.path) {
			// Workaround: send as 'file' instead of 'selection' because the Copilot CLI
			// server's session.send handler maps all attachments to {type, path, displayName},
			// reading .path (not .filePath) and dropping text/selection fields.
			// The selection text is inlined in the prompt by buildPrompt().
			const resolvedPath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'file',
				path: resolvedPath,
				displayName: att.name,
			});
		} else if (att.type === 'directory' && att.path) {
			const dirPath = att.absolutePath ? att.path : vaultBasePath + '/' + normalizePath(att.path);
			result.push({
				type: 'directory',
				path: dirPath,
				displayName: att.name,
			});
		}
	}

	// Add vault scope paths (skip children if a parent folder is selected)
	const scopeSorted = [...scopePaths].sort((a, b) => a.length - b.length);
	const includedFolders: string[] = [];

	for (const scopePath of scopeSorted) {
		// Skip if an ancestor folder is already included
		const normalized = normalizePath(scopePath);
		const isChild = includedFolders.some(parent =>
			parent === '/' || normalized.startsWith(parent + '/')
		);
		if (isChild) continue;

		const absPath = scopePath === '/'
			? vaultBasePath
			: vaultBasePath + '/' + normalized;
		const displayName = scopePath === '/' ? app.vault.getName() : scopePath;
		const abstract = scopePath === '/'
			? app.vault.getRoot()
			: app.vault.getAbstractFileByPath(scopePath);

		if (abstract instanceof TFolder) {
			result.push({type: 'directory', path: absPath, displayName});
			includedFolders.push(normalized);
		} else if (abstract instanceof TFile) {
			result.push({type: 'file', path: absPath, displayName});
		}
	}

	return result.length > 0 ? result : undefined;
}

/**
 * Build BYOK provider config from plugin settings.
 * Returns undefined when using the default GitHub provider.
 */
export function buildProviderConfig(settings: {
	providerPreset: string;
	providerBaseUrl?: string;
	providerApiKey?: string;
	providerBearerToken?: string;
	providerModel?: string;
	providerWireApi?: string;
}): ProviderConfig | undefined {
	if (settings.providerPreset === 'github' || !settings.providerBaseUrl) return undefined;
	const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
		openai: 'openai', azure: 'azure', anthropic: 'anthropic',
		ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
	};
	return {
		type: typeMap[settings.providerPreset] ?? 'openai',
		baseUrl: settings.providerBaseUrl,
		...(settings.providerApiKey ? {apiKey: resolveEnvRef(settings.providerApiKey)} : {}),
		...(settings.providerBearerToken ? {bearerToken: resolveEnvRef(settings.providerBearerToken)} : {}),
		wireApi: settings.providerWireApi,
	};
}

// ── Shared utilities ─────────────────────────────────────────

/**
 * Build the list of SDK tool names to exclude for a given agent.
 * Shell tools are excluded by default; agents opt in by listing them in their tools array.
 * If `alwaysExcludeShell` is true (e.g. search mode), all shell tools are blocked.
 */
export function buildExcludedTools(agent?: AgentConfig, alwaysExcludeShell = false): string[] {
	const excluded: string[] = [];
	if (alwaysExcludeShell) {
		excluded.push('bash', 'read_bash', 'stop_bash', 'write_bash', 'list_bash');
	} else {
		const agentTools = agent?.tools;
		if (!agentTools?.includes('bash')) excluded.push('bash', 'read_bash', 'stop_bash');
		if (!agentTools?.includes('write_bash')) excluded.push('write_bash');
		if (!agentTools?.includes('list_bash')) excluded.push('list_bash');
	}
	if (agent?.excludeTools) {
		for (const t of agent.excludeTools) {
			if (!excluded.includes(t)) excluded.push(t);
		}
	}
	return excluded;
}

/**
 * Build system message parts from global instructions + lightweight hints.
 * Returns the assembled string or undefined if no parts.
 */
export function buildSystemParts(opts: {
	globalInstructions?: string;
	agentInstructions?: string;
	hasMcpServers: boolean;
	contextMode: string;
	hasSkills: boolean;
	hasMcpTools: boolean;
}): string | undefined {
	const parts: string[] = [];
	if (opts.globalInstructions) parts.push(opts.globalInstructions);
	if (opts.agentInstructions) parts.push(opts.agentInstructions);
	if (opts.hasMcpServers) {
		parts.push('If a tool call fails, report the error to the user — do not retry the same call.');
	}
	if (opts.hasSkills || opts.hasMcpTools) {
		parts.push(
			'Skills and MCP tools are registered for this session. ' +
			'Use them when the request matches their capabilities.'
		);
	}
	if (opts.contextMode === 'suggest') {
		parts.push('Use on-demand file/search tools to gather vault context when needed instead of assuming local context is pre-attached.');
	}
	return parts.length > 0 ? parts.join('\n\n') : undefined;
}

// ── Custom vault tools (defineTool) ──────────────────────────────

/**
 * Build SDK custom tools that let the agent call back into the Obsidian vault.
 * These are read-only tools — they never modify vault content.
 */
export function buildVaultTools(app: App, vaultIndex: VaultIndex | null): Tool<unknown>[] {
	const tools: Tool<unknown>[] = [];

	// vault_search — search notes by query using the vault index pre-filter
	tools.push(defineTool('vault_search', {
		description: 'Search for notes in the Obsidian vault by keyword. Returns matching notes ranked by relevance based on filename, tags, headings, aliases, and folder path. Use this to discover relevant notes before reading them.',
		parameters: {
			type: 'object',
			properties: {
				query: {type: 'string', description: 'Search query (keywords to match against note titles, tags, headings, aliases)'},
				limit: {type: 'number', description: 'Maximum number of results to return (default: 15)'},
				folder: {type: 'string', description: 'Optional folder path to scope the search (e.g. "Projects/web")'},
			},
			required: ['query'],
		},
		handler: async (args: unknown) => {
			const {query, limit, folder} = args as {query: string; limit?: number; folder?: string};
			if (!vaultIndex) return {error: 'Vault index not available'};
			const scopePaths = folder ? [folder] : ['/'];
			const candidates = vaultIndex.preFilter(query, scopePaths, limit ?? 15);
			return candidates.map(c => ({
				path: c.note.path,
				name: c.note.name,
				score: c.score,
				matchReasons: c.matchReasons,
				tags: c.note.tags,
				headings: c.note.headings.slice(0, 5),
				folder: c.note.folder,
			}));
		},
	}) as Tool<unknown>);

	// vault_read_note — read a note's full content by path
	tools.push(defineTool('vault_read_note', {
		description: 'Read the full content of a note in the Obsidian vault by its file path. Returns the raw markdown text. Use vault_search first to find the path.',
		parameters: {
			type: 'object',
			properties: {
				path: {type: 'string', description: 'Vault-relative path to the note (e.g. "Projects/web/README.md")'},
			},
			required: ['path'],
		},
		handler: async (args: unknown) => {
			const {path} = args as {path: string};
			const file = app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) return {error: `File not found: ${path}`};
			const content = await app.vault.cachedRead(file);
			return {path: file.path, content};
		},
	}) as Tool<unknown>);

	// vault_list_folder — list files and subfolders in a vault directory
	tools.push(defineTool('vault_list_folder', {
		description: 'List files and subfolders in a vault directory. Returns names, types, and sizes. Useful for exploring vault structure.',
		parameters: {
			type: 'object',
			properties: {
				path: {type: 'string', description: 'Vault-relative folder path (e.g. "Projects" or "/" for root)'},
			},
			required: ['path'],
		},
		handler: async (args: unknown) => {
			const {path: folderPath} = args as {path: string};
			const normalized = folderPath === '/' ? '/' : normalizePath(folderPath);
			const folder = normalized === '/'
				? app.vault.getRoot()
				: app.vault.getAbstractFileByPath(normalized);
			if (!(folder instanceof TFolder)) return {error: `Folder not found: ${folderPath}`};
			const items = folder.children.map(child => {
				if (child instanceof TFile) {
					return {name: child.name, type: 'file' as const, size: child.stat.size};
				}
				return {name: child.name, type: 'folder' as const};
			});
			items.sort((a, b) => {
				if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			return {path: folderPath, items};
		},
	}) as Tool<unknown>);

	// vault_note_metadata — get metadata for a specific note without reading full content
	tools.push(defineTool('vault_note_metadata', {
		description: 'Get metadata for a note including tags, aliases, headings, links, frontmatter properties, and modification time. Lighter than reading full content.',
		parameters: {
			type: 'object',
			properties: {
				path: {type: 'string', description: 'Vault-relative path to the note'},
			},
			required: ['path'],
		},
		handler: async (args: unknown) => {
			const {path} = args as {path: string};
			const file = app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) return {error: `File not found: ${path}`};
			if (!vaultIndex) return {error: 'Vault index not available'};
			const meta = vaultIndex.getNoteMetadata(file);
			return {
				path: meta.path,
				name: meta.name,
				folder: meta.folder,
				tags: meta.tags,
				aliases: meta.aliases,
				headings: meta.headings,
				links: meta.links,
				backlinks: meta.backlinks,
				frontmatter: meta.frontmatter,
				mtime: meta.mtime,
				size: meta.size,
			};
		},
	}) as Tool<unknown>);

	return tools;
}

// ── Session hooks ────────────────────────────────────────────────

/**
 * Build session hooks for error recovery and lifecycle logging.
 */
export function buildHooks(): NonNullable<SessionConfig['hooks']> {
	return {
		onErrorOccurred: async (input: {error: string; errorContext: string; recoverable: boolean}) => {
			debugTrace('hook:onErrorOccurred', {
				error: input.error,
				errorContext: input.errorContext,
				recoverable: input.recoverable,
			});
			if (input.recoverable) {
				return {errorHandling: 'retry' as const, retryCount: 2};
			}
			return undefined;
		},
	};
}

// ── Mixin: methods installed onto SidekickView.prototype ─────────

export function installSessionConfigMixin(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildSessionConfig = function(opts: {
		model?: string;
		systemContent?: string;
		selectedAgentName?: string;
		skipSkills?: boolean;
	}): SessionConfig {
		// MCP servers — use shared utility
		const mcpServers = mapMcpServers(this.mcpServers, this.enabledMcpServers);
		const mcpServerNames = Object.keys(mcpServers);

		// Skills — skip entirely when invoked via a prompt slash command
		const basePath = this.getVaultBasePath();
		const skillDirs: string[] = [];
		let disabledSkills: string[] = [];
		if (!opts.skipSkills && this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
			disabledSkills = this.skills
				.filter(s => !this.enabledSkills.has(s.name))
				.map(s => s.name);
		}

		// Custom agents — pass ALL agents so the SDK can route between them
		// for delegation/handoff. When agentTriage is enabled, set infer: true
		// so the SDK can auto-route to the best-fit agent.
		const allowInfer = this.plugin.settings.agentTriage;
		const customAgents: CustomAgentConfig[] = this.agents.map(a => ({
			name: a.name,
			displayName: a.name,
			description: a.description || undefined,
			prompt: a.instructions,
			tools: a.tools ?? null,
			infer: allowInfer,
		}));

		// Determine shell tool exclusion from the selected agent's tool list.
		// Agents opt in by listing specific tool names in their tools array.
		const selectedAgent = opts.selectedAgentName
			? this.agents.find(a => a.name === opts.selectedAgentName)
			: undefined;

		// Permission handler
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// User input handler — shows a modal when the agent invokes ask_user
		const userInputHandler = (request: UserInputRequest) => {
			const modal = new UserInputModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// BYOK provider
		const provider = buildProviderConfig(this.plugin.settings);
		const providerPreset = this.plugin.settings.providerPreset;
		const reasoningEffort = this.plugin.settings.reasoningEffort;

		// System message: global instructions + lightweight behavioral hints.
		// Tool/skill catalogs are NOT injected here — the SDK discovers them
		// automatically from mcpServers and skillDirectories config.
		// Agent-specific instructions are in customAgents[].prompt.
		const finalSystemContent = buildSystemParts({
			globalInstructions: this.globalInstructions,
			hasMcpServers: mcpServerNames.length > 0,
			contextMode: this.plugin.settings.contextMode,
			hasSkills: skillDirs.length > 0,
			hasMcpTools: mcpServerNames.length > 0,
		});

		const excludedTools = buildExcludedTools(selectedAgent);

		// Custom vault tools — give the agent direct read-only access to the vault
		const vaultTools = buildVaultTools(this.app, this.vaultIndex);

		// Session hooks — error recovery for transient failures
		const hooks = buildHooks();

		debugTrace('buildSessionConfig', {
			mcpServerCount: mcpServerNames.length,
			mcpServerNames,
			mcpServerConfigs: Object.fromEntries(
				mcpServerNames.map(name => [name, {
					type: mcpServers[name]?.type,
					hasHeaders: !!(mcpServers[name] as Record<string, unknown>)?.['headers'],
					hasUrl: !!(mcpServers[name] as Record<string, unknown>)?.['url'],
				}])
			),
			skillDirectories: skillDirs,
			enabledSkills: this.skills.filter(s => this.enabledSkills.has(s.name)).map(s => s.name),
			disabledSkills,
			skipSkills: !!opts.skipSkills,
			selectedAgent: opts.selectedAgentName,
			excludedTools,
			vaultToolCount: vaultTools.length,
		});

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : opts.model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			onUserInputRequest: userInputHandler,
			hooks,
			workingDirectory: this.getWorkingDirectory(),
			...(vaultTools.length > 0 ? {tools: vaultTools} : {}),
			...(reasoningEffort !== '' ? {reasoningEffort: reasoningEffort as ReasoningEffort} : {}),
			...(provider ? {provider} : {}),
			...(mcpServerNames.length > 0 ? {mcpServers} : {}),
			...(customAgents.length > 0 ? {customAgents} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(excludedTools.length > 0 ? {excludedTools} : {}),
			...(finalSystemContent ? {systemMessage: {mode: 'append' as const, content: finalSystemContent}} : {}),
		};
	};

	proto.getSessionExtras = function(): {
		skillDirectories?: string[];
		disabledSkills?: string[];
		mcpServers?: Record<string, MCPServerConfig>;
		workingDirectory?: string;
	} {
		const basePath = this.getVaultBasePath();

		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		const mcpServers = mapMcpServers(this.mcpServers, this.enabledMcpServers);

		return {
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			workingDirectory: this.getWorkingDirectory(),
		};
	};

	proto.getWorkingDirectory = function(): string {
		const base = this.getVaultBasePath();
		if (!this.workingDir) return base;
		return base + '/' + normalizePath(this.workingDir);
	};

	proto.getAgentsFolder = function(): string {
		return getAgentsFolderSetting(this.plugin.settings);
	};

	proto.getVaultBasePath = function(): string {
		return (this.app.vault.adapter as unknown as {basePath: string}).basePath;
	};
}
