import {normalizePath, TFile, TFolder} from 'obsidian';
import type {App} from 'obsidian';
import type {MCPServerConfig, ModelInfo, MessageOptions, ProviderConfig, SessionConfig, ReasoningEffort, PermissionRequest, CustomAgentConfig} from '../copilot';
import {approveAll} from '../copilot';
import type {AgentConfig, McpServerEntry, ChatAttachment} from '../types';
import type {SidekickView} from '../sidekickView';
import {getSkillsFolder, getAgentsFolder as getAgentsFolderSetting} from '../settings';
import {resolveEnvRef} from '../secureStorage';
import {ToolApprovalModal} from '../modals/toolApprovalModal';
import {UserInputModal} from '../modals/userInputModal';
import type {UserInputRequest} from '../modals/userInputModal';
import {isProxyOnlyServer} from '../mcpProbe';
import {debugTrace} from '../debug';

/**
 * Map MCP server entries to MCPServerConfig objects, filtering by enabled set.
 *
 * Proxy-only servers (e.g. agent365 M365 servers) are excluded — they require
 * the Copilot CLI's own OAuth flow and are loaded from ~/.copilot/mcp-config.json
 * by the CLI binary automatically. Passing them in SessionConfig.mcpServers would
 * override the CLI's config and lose the OAuth context.
 */
export function mapMcpServers(mcpServers: McpServerEntry[], enabledMcpServers: Set<string>): Record<string, MCPServerConfig> {
	const result: Record<string, MCPServerConfig> = {};
	for (const server of mcpServers) {
		if (!enabledMcpServers.has(server.name)) continue;
		// Skip proxy-only servers — they're handled by the CLI's own OAuth
		// via ~/.copilot/mcp-config.json loaded at startup.
		if (isProxyOnlyServer(server)) continue;
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
		// for delegation/handoff. The selected agent's instructions are also
		// included in the system message when needed.
		const customAgents: CustomAgentConfig[] = this.agents.map(a => ({
			name: a.name,
			displayName: a.name,
			description: a.description || undefined,
			prompt: a.instructions,
			tools: a.tools ?? null,
			infer: true,
		}));

		// Determine shell tool exclusion from the selected agent's tool list.
		// Agents opt in by listing specific tool names in their tools array.
		const selectedAgent = opts.selectedAgentName
			? this.agents.find(a => a.name === opts.selectedAgentName)
			: undefined;
		const agentTools = selectedAgent?.tools;
		const allowsBash = !!agentTools?.includes('bash');
		const allowsWriteBash = !!agentTools?.includes('write_bash');
		const allowsListBash = !!agentTools?.includes('list_bash');

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

		// System message: global instructions + MCP tool catalog
		// (agent-specific instructions are in customAgents[].prompt)
		const systemParts: string[] = [];
		if (this.globalInstructions) {
			systemParts.push(this.globalInstructions);
		}
		if (mcpServerNames.length > 0) {
			systemParts.push(
				'Prefer MCP tools over bash/shell for external API calls. ' +
				'If a tool call fails, report the error to the user — do not retry the same call.'
			);

			// Include discovered tool catalog for proper routing
			const toolCatalogParts: string[] = [];
			for (const name of mcpServerNames) {
				const status = this.mcpServerStatus.get(name);
				if (status?.tools && status.tools.length > 0) {
					const toolLines = status.tools.map(t => `  - ${t.name}: ${t.description}`);
					toolCatalogParts.push(`MCP server "${name}" tools:\n${toolLines.join('\n')}`);
				}
			}
			if (toolCatalogParts.length > 0) {
				systemParts.push('Available MCP tools:\n' + toolCatalogParts.join('\n'));
			}
		}
		if (customAgents.length > 0) {
			systemParts.push(
				'If a subagent fails or reports it cannot access its required tools, ' +
				'report the failure to the user immediately — do not invoke the same subagent again or spawn additional subagents to retry.'
			);
		}
		if (this.plugin.settings.contextMode === 'suggest') {
			systemParts.push('Use on-demand file/search tools to gather vault context when needed instead of assuming local context is pre-attached.');
		}
		const finalSystemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

		const excludedTools: string[] = [];
		// Exclude shell tools by default — agents opt back in via their tools array.
		if (!allowsBash) excludedTools.push('bash');
		if (!allowsWriteBash) excludedTools.push('write_bash');
		if (!allowsListBash) excludedTools.push('list_bash');

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
			selectedAgent: opts.selectedAgentName,
			excludedTools,
		});

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : opts.model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			onUserInputRequest: userInputHandler,
			workingDirectory: this.getWorkingDirectory(),
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

	proto.triageRequest = async function(prompt: string): Promise<string | null> {
		if (!this.plugin.copilot) return null;
		if (this.agents.length <= 1) return null;
		if (this.selectedAgent) return null;

		const model = this.resolveModelForAgent(undefined, this.selectedModel || undefined);
		const agentList = this.agents
			.map(a => `- ${a.name}: ${a.description || 'no description'}`)
			.join('\n');
		const triagePrompt =
			`Given these available agents:\n${agentList}\n\n` +
			`Which single agent is the best fit for this request?\n` +
			`Request: "${prompt.slice(0, 200)}"\n\n` +
			`Respond with ONLY the agent name, nothing else. If none is a clear fit, respond "none".`;

		try {
			const result = await this.plugin.copilot.chat({prompt: triagePrompt, model});
			const name = result?.trim();
			if (!name || name.toLowerCase() === 'none') return null;

			const exact = this.agents.find(a => a.name.toLowerCase() === name.toLowerCase());
			return exact?.name ?? null;
		} catch {
			return null;
		}
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
