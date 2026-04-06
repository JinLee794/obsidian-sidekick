import {Notice, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {McpAuthConfig, McpToolInfo} from '../types';
import {getToolsFolder, setMcpInputValue} from '../settings';
import {McpEditorModal} from '../modals/mcpEditorModal';
import {AgencyConfigModal} from '../modals/agencyConfigModal';
import {debugTrace} from '../debug';
import {probeAllMcpServers, isProxyOnlyServer, isAgencyAvailable, isAgencyService, resetAgencyCache, enrichServersWithAzureAuth, needsAzureAuth, clearAzureTokenCache} from '../mcpProbe';

export function installToolsPanel(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildToolsPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-tools-wrapper'});

		// ── MCP servers section ──────────────────────────────
		const mcpSection = wrapper.createDiv({cls: 'sidekick-tools-section'});
		const mcpHeader = mcpSection.createDiv({cls: 'sidekick-tools-header'});
		mcpHeader.createDiv({cls: 'sidekick-tools-title', text: 'MCP servers'});
		const mcpControls = mcpHeader.createDiv({cls: 'sidekick-tools-controls'});
		const mcpPathEl = mcpControls.createSpan({
			cls: 'sidekick-tools-path',
			text: `${this.plugin.settings.sidekickFolder}/tools/mcp.json`,
		});
		mcpPathEl.setAttribute('title', 'MCP configuration file');
		const editBtn = mcpControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Edit mcp.json'},
		});
		setIcon(editBtn, 'pencil');
		editBtn.addEventListener('click', () => {
			const toolsFolder = getToolsFolder(this.plugin.settings);
			new McpEditorModal(this.app, toolsFolder, () => {
				void this.loadAllConfigs({silent: true}).then(() => this.renderMcpServersList());
			}).open();
		});
		const refreshBtn = mcpControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh'},
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => {
			void this.loadAllConfigs({silent: true}).then(() => {
				this.renderMcpServersList();
				this.scheduleMcpToolDiscovery();
			});
		});
		this.toolsMcpListEl = mcpSection.createDiv({cls: 'sidekick-tools-list'});
	};

	proto.buildAgencyPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-tools-wrapper'});

		const agencySection = wrapper.createDiv({cls: 'sidekick-tools-section'});
		const agencyHeader = agencySection.createDiv({cls: 'sidekick-tools-header'});
		agencyHeader.createDiv({cls: 'sidekick-tools-title', text: 'Agency services'});
		const agencyControls = agencyHeader.createDiv({cls: 'sidekick-tools-controls'});
		const agencyHint = agencyControls.createSpan({cls: 'sidekick-tools-agency-hint'});
		agencyHint.setText('via agency CLI');
		const agencySettingsBtn = agencyControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Configure agency services'},
		});
		setIcon(agencySettingsBtn, 'settings');
		agencySettingsBtn.addEventListener('click', () => {
			const toolsFolder = getToolsFolder(this.plugin.settings);
			new AgencyConfigModal(this.app, toolsFolder, this.agencyConfig, () => {
				resetAgencyCache();
				void this.loadAllConfigs({silent: true}).then(() => {
					this.renderAgencyServersList();
					this.scheduleMcpToolDiscovery();
				});
			}).open();
		});
		const agencyRefreshBtn = agencyControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh agency services'},
		});
		setIcon(agencyRefreshBtn, 'refresh-cw');
		agencyRefreshBtn.addEventListener('click', () => {
			resetAgencyCache();
			void this.loadAllConfigs({silent: true}).then(() => {
				this.renderAgencyServersList();
				this.scheduleMcpToolDiscovery();
			});
		});
		this.toolsAgencyListEl = agencySection.createDiv({cls: 'sidekick-tools-list'});
	};

	proto.buildAgentsPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-tools-wrapper'});

		const agentSection = wrapper.createDiv({cls: 'sidekick-tools-section'});
		const agentHeader = agentSection.createDiv({cls: 'sidekick-tools-header'});
		agentHeader.createDiv({cls: 'sidekick-tools-title', text: 'Agent tool access'});
		const agentControls = agentHeader.createDiv({cls: 'sidekick-tools-controls'});
		const newAgentBtn = agentControls.createEl('button', {cls: 'clickable-icon sidekick-triggers-ctrl-btn', attr: {title: 'New agent'}});
		setIcon(newAgentBtn, 'plus');
		newAgentBtn.addEventListener('click', () => this.openAgentEditor());
		this.toolsAgentListEl = agentSection.createDiv({cls: 'sidekick-tools-list'});
	};

	proto.renderToolsPanel = function(): void {
		this.renderMcpServersList();
	};

	proto.renderMcpServersList = function(): void {
		this.toolsMcpListEl.empty();

		// Filter out agency-discovered servers — they go in their own section
		const userServers = this.mcpServers.filter((s: {name: string; config: Record<string, unknown>}) => !isAgencyService(s));

		if (userServers.length === 0) {
			const empty = this.toolsMcpListEl.createDiv({cls: 'sidekick-tools-empty'});
			empty.createSpan({text: 'No MCP servers configured. '});
			const hint = empty.createSpan({cls: 'sidekick-tools-hint'});
			hint.setText(`Add servers to ${this.plugin.settings.sidekickFolder}/tools/mcp.json`);
			return;
		}

		for (const server of userServers) {
			const item = this.toolsMcpListEl.createDiv({cls: 'sidekick-tools-item'});
			const enabled = this.enabledMcpServers.has(server.name);
			const runtimeStatus = this.mcpServerStatus.get(server.name);

			// Status indicator — show runtime connection status when available
			const statusDot = item.createSpan({cls: 'sidekick-tools-status-dot'});
			if (runtimeStatus) {
				statusDot.toggleClass('is-connected', runtimeStatus.status === 'connected');
				statusDot.toggleClass('is-error', runtimeStatus.status === 'error');
				statusDot.toggleClass('is-pending', runtimeStatus.status === 'pending');
				const label = runtimeStatus.status === 'connected' ? 'Connected'
					: runtimeStatus.status === 'error' ? 'Error'
					: 'Connecting…';
				statusDot.setAttribute('title', runtimeStatus.message || label);
			} else {
				statusDot.toggleClass('is-enabled', enabled);
				statusDot.toggleClass('is-disabled', !enabled);
				statusDot.setAttribute('title', enabled ? 'Enabled (not yet connected)' : 'Disabled');
			}

			// Server info
			const info = item.createDiv({cls: 'sidekick-tools-item-info'});
			const nameRow = info.createDiv({cls: 'sidekick-tools-item-name'});
			nameRow.setText(server.name);

			// Auth refresh button — shown when server has auth config
			if (server.auth) {
				const authBtn = nameRow.createEl('button', {
					cls: 'clickable-icon sidekick-tools-auth-btn',
					attr: {title: `Refresh auth (${server.auth.command} ${(server.auth.args ?? []).join(' ')})`},
				});
				setIcon(authBtn, 'key');
				authBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					void this.runAuthRefresh(server.name, server.auth!);
				});
			}

			// Connection status message when there's an error
			if (runtimeStatus?.status === 'error' && runtimeStatus.message) {
				const errMsg = info.createDiv({cls: 'sidekick-tools-item-error'});
				errMsg.setText(runtimeStatus.message);
			}

			// Note for proxy-only servers
			if (enabled && isProxyOnlyServer(server) && !runtimeStatus?.tools?.length) {
				const note = info.createDiv({cls: 'sidekick-tools-item-proxy-note'});
				if (isAgencyAvailable()) {
					note.setText('Proxied via agency CLI — discovering tools…');
				} else {
					note.setText('Install agency CLI (https://aka.ms/agency) to connect, or authenticate via Copilot SDK');
				}
			}

			// Note for Azure-authenticated servers that failed
			if (enabled && !isProxyOnlyServer(server) && needsAzureAuth(server) && runtimeStatus?.status === 'error' && runtimeStatus?.httpStatus === 401) {
				const note = info.createDiv({cls: 'sidekick-tools-item-proxy-note'});
				note.setText('Sign in with `az login` then click refresh to authenticate');
			}

			const meta = info.createDiv({cls: 'sidekick-tools-item-meta'});

			// Server type
			const cfg = server.config;
			const isAgencyProxied = isProxyOnlyServer(server) && isAgencyAvailable();
			const serverType = isAgencyProxied
				? 'agency'
				: (cfg['type'] as string | undefined) ?? (cfg['command'] ? 'local' : 'unknown');
			const typeTag = meta.createSpan({cls: 'sidekick-tools-tag'});
			typeTag.setText(serverType);

			// URL or command
			if (serverType === 'http' || serverType === 'sse') {
				const urlTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				urlTag.setText(cfg['url'] as string || '');
				urlTag.setAttribute('title', cfg['url'] as string || '');
			} else if (cfg['command']) {
				const cmdTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				const cmd = cfg['command'] as string;
				const args = (cfg['args'] as string[] | undefined) ?? [];
				cmdTag.setText(`${cmd} ${args.join(' ')}`.trim());
				cmdTag.setAttribute('title', `${cmd} ${args.join(' ')}`.trim());
			}

			// Tools filter from config
			const tools = cfg['tools'] as string[] | undefined;
			if (tools && tools.length > 0 && !(tools.length === 1 && tools[0] === '*')) {
				const toolsTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent'});
				toolsTag.setText(`${tools.length} tool(s)`);
				toolsTag.setAttribute('title', tools.join(', '));
			}

			// Discovered tools from runtime handshake
			const discoveredTools = runtimeStatus?.tools;
			if (discoveredTools && discoveredTools.length > 0) {
				const details = info.createEl('details', {cls: 'sidekick-tools-discovered-details'});
				const summary = details.createEl('summary', {cls: 'sidekick-tools-discovered-summary'});
				summary.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: `${discoveredTools.length} tool(s) available`});

				const toolsListEl = details.createDiv({cls: 'sidekick-tools-discovered'});
				for (const tool of discoveredTools) {
					const toolEl = toolsListEl.createDiv({cls: 'sidekick-tools-discovered-item'});
					const dot = toolEl.createSpan({cls: 'sidekick-tools-discovered-dot'});
					dot.toggleClass('is-connected', runtimeStatus?.status === 'connected');
					toolEl.createSpan({cls: 'sidekick-tools-discovered-name', text: tool.name});
					if (tool.description) {
						const descEl = toolEl.createSpan({cls: 'sidekick-tools-discovered-desc'});
						descEl.setText(tool.description);
						descEl.setAttribute('title', tool.description);
					}
				}
			} else if (enabled && (!isProxyOnlyServer(server) || isAgencyAvailable())) {
				const pendingTag = meta.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				pendingTag.setText('Click refresh to discover tools');
			}

			// Toggle — use Obsidian's native toggle structure
			const toggleContainer = item.createDiv({cls: 'checkbox-container sidekick-tools-toggle'});
			toggleContainer.toggleClass('is-enabled', enabled);
			const checkbox = toggleContainer.createEl('input', {type: 'checkbox'});
			checkbox.checked = enabled;
			checkbox.tabIndex = 0;
			toggleContainer.addEventListener('click', (e) => {
				if (e.target === checkbox) return;
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event('change'));
			});
			checkbox.addEventListener('change', () => {
				const shouldEnable = checkbox.checked;
				checkbox.disabled = true;
				void this.setMcpServerEnabled(server, shouldEnable).finally(() => {
					if (!checkbox.isConnected) return;
					checkbox.disabled = false;
					checkbox.checked = this.enabledMcpServers.has(server.name);
					toggleContainer.toggleClass('is-enabled', checkbox.checked);
				});
			});
		}
	};

	proto.renderAgencyServersList = function(): void {
		this.toolsAgencyListEl.empty();
		const agencyServers = this.mcpServers.filter((s: {name: string; config: Record<string, unknown>}) => isAgencyService(s));

		if (agencyServers.length === 0) {
			if (!isAgencyAvailable()) {
				const empty = this.toolsAgencyListEl.createDiv({cls: 'sidekick-tools-empty'});
				empty.setText('Agency CLI not installed. Get it at https://aka.ms/agency');
			} else {
				const empty = this.toolsAgencyListEl.createDiv({cls: 'sidekick-tools-empty'});
				empty.setText('No agency services configured. Click the settings icon to add services.');
			}
			return;
		}

		for (const server of agencyServers) {
			const item = this.toolsAgencyListEl.createDiv({cls: 'sidekick-tools-item'});
			const enabled = this.enabledMcpServers.has(server.name);
			const runtimeStatus = this.mcpServerStatus.get(server.name);

			// Status dot
			const statusDot = item.createSpan({cls: 'sidekick-tools-status-dot'});
			if (runtimeStatus) {
				statusDot.toggleClass('is-connected', runtimeStatus.status === 'connected');
				statusDot.toggleClass('is-error', runtimeStatus.status === 'error');
				statusDot.toggleClass('is-pending', runtimeStatus.status === 'pending');
				statusDot.setAttribute('title', runtimeStatus.message || runtimeStatus.status);
			} else {
				statusDot.toggleClass('is-enabled', enabled);
				statusDot.toggleClass('is-disabled', !enabled);
				statusDot.setAttribute('title', enabled ? 'Enabled' : 'Disabled');
			}

			const info = item.createDiv({cls: 'sidekick-tools-item-info'});

			// Service name (strip agency- prefix for display)
			const serviceName = (server.config['_agencyService'] as string) || server.name;
			const nameRow = info.createDiv({cls: 'sidekick-tools-item-name'});
			nameRow.setText(serviceName);

			// Description
			const agencyDesc = server.config['_agencyDescription'] as string | undefined;
			if (agencyDesc) {
				const descEl = info.createDiv({cls: 'sidekick-tools-item-desc'});
				descEl.setText(agencyDesc);
			}

			// Error message
			if (runtimeStatus?.status === 'error' && runtimeStatus.message) {
				const errMsg = info.createDiv({cls: 'sidekick-tools-item-error'});
				errMsg.setText(runtimeStatus.message);
			}

			// Discovered tools
			const discoveredTools = runtimeStatus?.tools;
			if (discoveredTools && discoveredTools.length > 0) {
				const details = info.createEl('details', {cls: 'sidekick-tools-discovered-details'});
				const summary = details.createEl('summary', {cls: 'sidekick-tools-discovered-summary'});
				summary.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: `${discoveredTools.length} tool(s) available`});
				const toolsListEl = details.createDiv({cls: 'sidekick-tools-discovered'});
				for (const tool of discoveredTools) {
					const toolEl = toolsListEl.createDiv({cls: 'sidekick-tools-discovered-item'});
					const dot = toolEl.createSpan({cls: 'sidekick-tools-discovered-dot'});
					dot.toggleClass('is-connected', runtimeStatus?.status === 'connected');
					toolEl.createSpan({cls: 'sidekick-tools-discovered-name', text: tool.name});
					if (tool.description) {
						const descEl = toolEl.createSpan({cls: 'sidekick-tools-discovered-desc'});
						descEl.setText(tool.description);
						descEl.setAttribute('title', tool.description);
					}
				}
			}

			// Toggle
			const toggleContainer = item.createDiv({cls: 'checkbox-container sidekick-tools-toggle'});
			toggleContainer.toggleClass('is-enabled', enabled);
			const checkbox = toggleContainer.createEl('input', {type: 'checkbox'});
			checkbox.checked = enabled;
			checkbox.tabIndex = 0;
			toggleContainer.addEventListener('click', (e) => {
				if (e.target === checkbox) return;
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event('change'));
			});
			checkbox.addEventListener('change', () => {
				const shouldEnable = checkbox.checked;
				checkbox.disabled = true;
				void this.setMcpServerEnabled(server, shouldEnable).finally(() => {
					if (!checkbox.isConnected) return;
					checkbox.disabled = false;
					checkbox.checked = this.enabledMcpServers.has(server.name);
					toggleContainer.toggleClass('is-enabled', checkbox.checked);
				});
			});
		}
	};

	proto.renderAgentToolMappings = function(): void {
		this.toolsAgentListEl.empty();

		if (this.agents.length === 0) {
			const empty = this.toolsAgentListEl.createDiv({cls: 'sidekick-tools-empty'});
			empty.setText('No agents configured.');
			return;
		}

		for (const agent of this.agents) {
			const item = this.toolsAgentListEl.createDiv({cls: 'sidekick-tools-agent-item'});

			const header = item.createDiv({cls: 'sidekick-tools-agent-header'});
			const iconEl = header.createSpan({cls: 'sidekick-tools-agent-icon'});
			setIcon(iconEl, 'bot');
			header.createSpan({cls: 'sidekick-tools-agent-name', text: agent.name});

			// Edit button
			const editBtn = header.createEl('button', {cls: 'clickable-icon sidekick-tools-agent-edit', attr: {title: 'Edit agent'}});
			setIcon(editBtn, 'pencil');
			editBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openAgentEditor(agent); });

			if (agent.description) {
				const desc = item.createDiv({cls: 'sidekick-tools-agent-desc'});
				desc.setText(agent.description);
				desc.setAttribute('title', agent.description);
			}

			// Collapsible tools/skills section
			const details = item.createEl('details', {cls: 'sidekick-tools-agent-details'});
			const toolCount = agent.tools === undefined
				? this.mcpServers.length
				: agent.tools.length;
			const skillCount = agent.skills === undefined
				? this.skills.length
				: agent.skills.length;
			const summary = details.createEl('summary', {cls: 'sidekick-tools-agent-summary'});
			summary.createSpan({text: `${toolCount} tool(s), ${skillCount} skill(s)`});

			const toolsList = details.createDiv({cls: 'sidekick-tools-agent-tools'});

			// Determine which servers this agent has access to
			if (agent.tools === undefined) {
				// undefined = all servers
				const allTag = toolsList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent'});
				allTag.setText('All MCP servers');
				for (const server of this.mcpServers) {
					const tag = toolsList.createSpan({cls: 'sidekick-tools-tag'});
					tag.toggleClass('is-enabled', this.enabledMcpServers.has(server.name));
					tag.setText(server.name);
				}
			} else if (agent.tools.length === 0) {
				const noneTag = toolsList.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
				noneTag.setText('No tools');
			} else {
				const agentNames = new Set(this.agents.map(a => a.name));
				for (const toolName of agent.tools) {
					const isAgentRef = agentNames.has(toolName) && toolName !== agent.name;
					const tag = toolsList.createSpan({cls: 'sidekick-tools-tag'});
					if (isAgentRef) {
						tag.toggleClass('is-enabled', true);
						tag.toggleClass('sidekick-tools-tag-agent', true);
						tag.setText(`\u2BA9 ${toolName}`);
						tag.setAttribute('title', `Sub-agent: ${toolName}`);
					} else {
						const serverExists = this.mcpServers.some(s => s.name === toolName);
						const isEnabled = this.enabledMcpServers.has(toolName);
						tag.toggleClass('is-enabled', serverExists && isEnabled);
						tag.toggleClass('is-missing', !serverExists);
						tag.setText(toolName);
						if (!serverExists) {
							tag.setAttribute('title', 'Server not found in mcp.json');
						}
					}
				}
			}

			// Skills section
			if (this.skills.length > 0) {
				const skillsRow = details.createDiv({cls: 'sidekick-tools-agent-tools'});
				if (agent.skills === undefined) {
					skillsRow.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-accent', text: 'All skills'});
					for (const skill of this.skills) {
						const tag = skillsRow.createSpan({cls: 'sidekick-tools-tag'});
						tag.toggleClass('is-enabled', this.enabledSkills.has(skill.name));
						tag.setText(skill.name);
					}
				} else if (agent.skills.length === 0) {
					skillsRow.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted', text: 'No skills'});
				} else {
					for (const skillName of agent.skills) {
						const tag = skillsRow.createSpan({cls: 'sidekick-tools-tag'});
						const exists = this.skills.some(s => s.name === skillName);
						tag.toggleClass('is-enabled', exists && this.enabledSkills.has(skillName));
						tag.toggleClass('is-missing', !exists);
						tag.setText(skillName);
					}
				}
			}

			// Excluded built-in tools section
			if (agent.excludeTools && agent.excludeTools.length > 0) {
				const excludeRow = details.createDiv({cls: 'sidekick-tools-agent-tools'});
				excludeRow.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted', text: 'Excluded:'});
				for (const toolName of agent.excludeTools) {
					const tag = excludeRow.createSpan({cls: 'sidekick-tools-tag sidekick-tools-tag-muted'});
					tag.setText(toolName);
				}
			}
		}
	};

	proto.handleMcpSessionEvent = function(category: string, message: string, level: 'info' | 'warning'): void {
		if (category !== 'mcp') return;
		debugTrace('MCP session event', {category, message, level});

		// Parse server name from typical MCP messages like "MCP server 'name': connected"
		const serverMatch = message.match(/MCP server ['"]?([^'":\s]+)['"]?\s*:\s*(.*)/i)
			?? message.match(/(?:connected|failed|error|started|auth\w*)\s+(?:MCP server\s+)?['"]?([^'":\s]+)['"]?/i);

		let newlyConnected = false;
		if (serverMatch) {
			const serverName = serverMatch[1]!;
			const detail = serverMatch[2] || '';
			const lowerMsg = (detail || message).toLowerCase();
			const prev = this.mcpServerStatus.get(serverName);
			debugTrace('MCP server event parsed', {serverName, detail, lowerMsg});

			if (lowerMsg.includes('connect') && !lowerMsg.includes('fail') && !lowerMsg.includes('error') && !lowerMsg.includes('disconnect')) {
				this.mcpServerStatus.set(serverName, {status: 'connected', message, tools: prev?.tools});
				if (!prev || prev.status !== 'connected') newlyConnected = true;
			} else if (lowerMsg.includes('error') || lowerMsg.includes('fail') || lowerMsg.includes('auth') || lowerMsg.includes('sign')) {
				this.mcpServerStatus.set(serverName, {status: 'error', message});
			} else {
				this.mcpServerStatus.set(serverName, {status: 'pending', message, tools: prev?.tools});
			}
		} else {
			debugTrace('MCP event - no server match', {message});
		}

		if (level === 'warning') {
			this.addInfoMessage(`MCP: ${message}`);
		}

		this.renderMcpServersList();
		this.renderAgencyServersList();

		// When a server newly connects, try to discover tools via SDK
		if (newlyConnected) {
			this.scheduleSdkToolDiscovery(1000);
		}
	};

	proto.refreshMcpToolsList = async function(): Promise<void> {
		if (this.mcpServers.length === 0 || this.enabledMcpServers.size === 0) return;

		try {
			// Enrich Azure-authenticated servers with fresh tokens before probing
			const enriched = await enrichServersWithAzureAuth(this.mcpServers, this.enabledMcpServers);
			if (enriched.size > 0) {
				for (const name of enriched) {
					const prev = this.mcpServerStatus.get(name);
					if (!prev || prev.status !== 'connected') {
						this.mcpServerStatus.set(name, {status: 'pending', message: 'Authenticating via Azure CLI…', tools: prev?.tools});
					}
				}
				this.renderMcpServersList();
				this.renderAgencyServersList();
			}

			const results = await probeAllMcpServers(this.mcpServers, this.enabledMcpServers);

			for (const result of results) {
				const existing = this.mcpServerStatus.get(result.serverName);
				if (result.tools.length > 0) {
					this.mcpServerStatus.set(result.serverName, {
						status: 'connected',
						message: existing?.message,
						tools: result.tools,
					});
				} else if (result.skipped) {
					// Proxy-only — status tracked from session events + SDK tools.list
				} else if (result.error) {
					if (result.httpStatus === 401) {
						const server = this.mcpServers.find(s => s.name === result.serverName);
						if (server && needsAzureAuth(server)) {
							clearAzureTokenCache();
						}
					}
					this.mcpServerStatus.set(result.serverName, {
						status: 'error',
						message: result.error,
						tools: existing?.tools,
						httpStatus: result.httpStatus,
					});
				}
			}

			this.renderMcpServersList();
			this.renderAgencyServersList();
		} catch (e) {
			debugTrace('refreshMcpToolsList error', {error: String(e)});
		}
	};

	proto.discoverToolsViaSdk = async function(): Promise<void> {
		if (!this.plugin.copilot) return;
		try {
			const sdkTools = await this.plugin.copilot.listTools();
			debugTrace('SDK tools.list result', {
				totalTools: sdkTools.length,
				mcpTools: sdkTools.filter(t => t.namespacedName).map(t => ({
					name: t.name,
					namespacedName: t.namespacedName,
					description: t.description?.substring(0, 50),
				})),
			});

			// Group MCP tools by server name from namespacedName (e.g. "mail/get_messages")
			const mcpToolsByServer = new Map<string, McpToolInfo[]>();
			for (const tool of sdkTools) {
				if (!tool.namespacedName) continue;
				const slashIdx = tool.namespacedName.indexOf('/');
				if (slashIdx <= 0) continue;
				const serverName = tool.namespacedName.substring(0, slashIdx);
				// Only track tools for servers we know about
				if (!this.enabledMcpServers.has(serverName)) continue;
				let list = mcpToolsByServer.get(serverName);
				if (!list) {
					list = [];
					mcpToolsByServer.set(serverName, list);
				}
				list.push({
					name: tool.name,
					namespacedName: tool.namespacedName,
					description: tool.description || '',
				});
			}

			let updated = false;
			for (const [serverName, tools] of mcpToolsByServer) {
				const existing = this.mcpServerStatus.get(serverName);
				if (!existing?.tools || existing.tools.length < tools.length) {
					this.mcpServerStatus.set(serverName, {
						status: 'connected',
						message: 'Connected via Copilot',
						tools,
					});
					updated = true;
				}
			}

			if (updated) {
				this.renderMcpServersList();
				this.renderAgencyServersList();
			}
		} catch (e) {
			debugTrace('discoverToolsViaSdk error', {error: String(e)});
		}
	};

	proto.scheduleSdkToolDiscovery = function(initialDelay = 2000): void {
		if (this.sdkToolDiscoveryTimer) clearTimeout(this.sdkToolDiscoveryTimer);
		// Single delayed discovery call — relies on session events for re-triggers
		// rather than a polling loop. handleMcpSessionEvent calls this again on connect.
		this.sdkToolDiscoveryTimer = setTimeout(async () => {
			await this.discoverToolsViaSdk();
		}, initialDelay);
	};

	proto.trackDiscoveredTool = function(serverName: string, toolName: string): void {
		const status = this.mcpServerStatus.get(serverName);
		const tools = status?.tools ?? [];
		if (tools.some(t => t.name === toolName)) return;
		tools.push({name: toolName, description: ''});
		this.mcpServerStatus.set(serverName, {
			status: 'connected',
			message: status?.message,
			tools,
		});
		this.renderMcpServersList();
		this.renderAgencyServersList();
	};

	proto.scheduleMcpToolDiscovery = function(): void {
		// Show pending state immediately for enabled servers that need probing
		let anyPending = false;
		for (const server of this.mcpServers) {
			if (!this.enabledMcpServers.has(server.name)) continue;
			const existing = this.mcpServerStatus.get(server.name);
			if (!existing || (!existing.tools?.length && existing.status !== 'pending')) {
				this.mcpServerStatus.set(server.name, {
					status: 'pending',
					message: 'Discovering tools…',
					tools: existing?.tools,
				});
				anyPending = true;
			}
		}
		if (anyPending) {
			this.renderMcpServersList();
			this.renderAgencyServersList();
		}
		// Start probing immediately (no delay)
		void this.refreshMcpToolsList();
		// Also schedule SDK-based discovery for proxy-only servers
		const hasProxy = this.mcpServers.some(
			s => this.enabledMcpServers.has(s.name) && isProxyOnlyServer(s)
		);
		if (hasProxy) {
			this.scheduleSdkToolDiscovery(2000);
		}
	};

	proto.runAuthRefresh = async function(
		serverName: string,
		auth: McpAuthConfig,
		options?: {showSuccessNotice?: boolean; reloadConfigs?: boolean},
	): Promise<boolean> {
		const nodeRequire = (window as unknown as {require?: NodeRequire}).require;
		const {execFile} = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
		const {promisify} = nodeRequire?.('node:util') as typeof import('node:util') ?? await import('node:util');
		const execFileAsync = promisify(execFile);
		const showSuccessNotice = options?.showSuccessNotice ?? true;
		const reloadConfigs = options?.reloadConfigs ?? true;
		const previouslyEnabled = new Set(this.enabledMcpServers);

		new Notice(`Refreshing auth for ${serverName}…`);

		// Build a PATH that includes common binary directories
		const home = process.env['HOME'] || '';
		const extraDirs = ['/usr/local/bin', '/opt/homebrew/bin'];
		if (home) extraDirs.push(`${home}/.local/bin`);
		const searchPath = [...extraDirs, process.env['PATH'] || ''].join(':');

		try {
			const {stdout, stderr} = await execFileAsync(auth.command, auth.args ?? [], {
				timeout: 60_000,
				env: {...process.env, PATH: searchPath},
			});

			const output = stdout.trim();

			// If setInput is configured, store the captured output as an MCP input variable
			if (auth.setInput && output) {
				await setMcpInputValue(this.app, this.plugin, auth.setInput, output, false);
				if (showSuccessNotice) {
					new Notice(`Auth refreshed for ${serverName} — token saved to input "${auth.setInput}".`);
				}
			} else if (auth.setInput && !output) {
				new Notice(`Auth command for ${serverName} produced no output — input "${auth.setInput}" not updated.`);
			} else if (showSuccessNotice) {
				new Notice(`Auth refreshed for ${serverName}.`);
			}

			if (stderr?.trim()) {
				console.log(`Sidekick: auth refresh stderr for ${serverName}:`, stderr.trim());
			}

			// Reload configs so newly stored input values are resolved in server configs.
			if (reloadConfigs) {
				await this.loadAllConfigs({silent: true});
				this.enabledMcpServers = new Set(
					this.mcpServers
						.filter(server => previouslyEnabled.has(server.name))
						.map(server => server.name)
				);
				this.configDirty = true;
				this.updateToolsBadge();
			}
			if (this.activeTab === 'tools') this.renderMcpServersList();
			if (this.activeTab === 'agency') this.renderAgencyServersList();
			return true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`Sidekick: auth refresh failed for ${serverName}:`, err);
			new Notice(`Auth refresh failed for ${serverName}: ${msg}`);
			return false;
		}
	};
}
