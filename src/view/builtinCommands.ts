import {TFile, TFolder, normalizePath, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import {getTriggersFolder} from '../settings';

export function installBuiltinCommands(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.executeBuiltinCommand = function(name: string, arg?: string): void {
		switch (name) {
			case 'clear':
				this.newConversation();
				// Disconnect the session entirely so context is fully cleared
				if (this.currentSession) {
					void this.disconnectSession();
					this.currentSessionId = null;
					this.configDirty = true;
				}
				this.addInfoMessage('Context cleared. Starting fresh.');
				break;
			case 'new':
				this.newConversation();
				break;
			case 'help':
				this.showHelpInfo();
				break;
			case 'agents':
				this.showAgentsList();
				break;
			case 'models':
				this.showModelsList();
				break;
			case 'model':
				if (arg) {
					const model = this.models.find(m => m.id === arg || m.name?.toLowerCase() === arg.toLowerCase());
					if (model) {
						this.selectedModel = model.id;
						this.modelSelect.value = model.id;
						this.configDirty = true;
						this.updateReasoningBadge();
						this.addInfoMessage(`Switched to model: ${model.name || model.id}`);
					} else {
						this.addInfoMessage(`Unknown model: ${arg}. Use /models to see available models.`);
					}
				} else {
					this.showModelsList();
				}
				break;
			case 'agent':
				if (arg) {
					const agent = this.agents.find(a => a.name.toLowerCase() === arg.toLowerCase());
					if (agent) {
						this.selectAgent(agent.name);
						this.addInfoMessage(`Switched to agent: ${agent.name}`);
					} else {
						this.addInfoMessage(`Unknown agent: ${arg}. Use /agents to see available agents.`);
					}
				} else {
					this.showAgentsList();
				}
				break;
			case 'trigger-debug':
				this.showTriggerDebug();
				break;
			case 'tasks':
				this.showTasksOverview();
				break;
			case 'reference':
				void this.showReference();
				break;
		}
	};

	proto.showHelpInfo = function(): void {
		const ViewClass = this.constructor as typeof import('../sidekickView').SidekickView;
		const commandLines = ViewClass.BUILTIN_COMMANDS.map(c => `  /${c.name} — ${c.description}`).join('\n');
		const agentLines = this.agents.length > 0
			? this.agents.map(a => `  @${a.name} — ${a.description || 'No description'}`).join('\n')
			: '  (none configured)';
		const promptLines = this.prompts.length > 0
			? this.prompts.map(p => `  /${p.name} — ${p.description || p.content.slice(0, 60)}`).join('\n')
			: '  (none configured)';

		const helpText = [
			'**Commands:**',
			commandLines,
			'',
			'**Agents** (use @name to invoke):',
			agentLines,
			'',
			'**Prompts** (use /name to apply):',
			promptLines,
			'',
			'**Tips:**',
			'  • Type `/` to see all commands and prompts',
			'  • Type `@` to see available agents and delegate to them',
			'  • Use `@agent your question` to send a message with a specific agent',
		].join('\n');
		this.addInfoMessage(helpText);
	};

	proto.showAgentsList = function(): void {
		if (this.agents.length === 0) {
			this.addInfoMessage('No agents configured. Add .agent.md files to your sidekick agents folder.');
			return;
		}
		const lines = this.agents.map(a => {
			const active = a.name === this.selectedAgent ? ' ✓' : '';
			return `  @${a.name}${active} — ${a.description || 'No description'}`;
		});
		this.addInfoMessage('**Available agents:**\n' + lines.join('\n') + '\n\nUse @agent-name in your message to delegate, or /agent name to switch.');
	};

	proto.showModelsList = function(): void {
		if (this.models.length === 0) {
			this.addInfoMessage('No models available.');
			return;
		}
		const lines = this.models.map(m => {
			const active = m.id === this.selectedModel ? ' ✓' : '';
			return `  ${m.name || m.id}${active}`;
		});
		this.addInfoMessage('**Available models:**\n' + lines.join('\n') + '\n\nUse /model name to switch.');
	};

	proto.showReference = async function(): Promise<void> {
		const helpPath = normalizePath(`${this.plugin.settings.sidekickFolder}/HELP.md`);
		const file = this.app.vault.getAbstractFileByPath(helpPath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			this.addInfoMessage(content);
		} else {
			// Generate in-line if HELP.md doesn't exist yet
			const {HELP_MD_CONTENT} = await import('../settings');
			this.addInfoMessage(HELP_MD_CONTENT);
		}
	};

	proto.showTriggerDebug = function(): void {
		const lines: string[] = ['**Trigger diagnostic:**'];

		// Copilot status
		lines.push(`- Copilot connected: ${this.plugin.copilot ? 'yes' : '**NO** — triggers will not fire'}`);

		// Triggers folder
		const triggersFolder = getTriggersFolder(this.plugin.settings);
		const folderExists = this.app.vault.getAbstractFileByPath(triggersFolder) instanceof TFolder;
		lines.push(`- Triggers folder: \`${triggersFolder}\` ${folderExists ? '✓ exists' : '**NOT FOUND** — create this folder and add .trigger.md files'}`);

		// Loaded triggers
		lines.push(`- Loaded triggers: ${this.triggers.length}`);
		if (this.triggers.length === 0) {
			lines.push('  - *(none — make sure files are named `something.trigger.md`)*');
		} else {
			for (const t of this.triggers) {
				const status = t.enabled ? '✓' : '✗ disabled';
				const schedule = [
					t.glob ? `glob: \`${t.glob}\`` : null,
					t.cron ? `cron: \`${t.cron}\`` : null,
				].filter(Boolean).join(', ') || 'no schedule';
				lines.push(`  - ${status} **${t.name}** — ${schedule}`);
			}
		}

		// Scheduler status
		const enabledInScheduler = this.triggerScheduler
			? (this.triggers.filter(t => t.enabled && t.glob).length)
			: 0;
		lines.push(`- Active glob triggers in scheduler: ${enabledInScheduler}`);

		// Last fired times
		const lastFired = this.plugin.settings.triggerLastFired;
		if (lastFired && Object.keys(lastFired).length > 0) {
			lines.push('');
			lines.push('**Last fired:**');
			for (const [key, ts] of Object.entries(lastFired)) {
				const ago = Math.round((Date.now() - ts) / 1000);
				lines.push(`- ${key}: ${ago}s ago`);
			}
		} else {
			lines.push('- Last fired: *(never)*');
		}

		lines.push('');
		lines.push('*Enable debug mode (checkbox at top) and edit a .md file to see detailed traces in the browser console (DevTools → Console).*');

		this.addInfoMessage(lines.join('\n'));
	};

	proto.showTasksOverview = function(): void {
		const panel = this.chatContainer.createDiv({cls: 'sidekick-tasks-panel'});

		// ── Active tasks ──────────────────────────────────────
		const activeSection = panel.createDiv({cls: 'sidekick-tasks-section'});
		const activeHeader = activeSection.createDiv({cls: 'sidekick-tasks-header'});
		const activeIcon = activeHeader.createSpan({cls: 'sidekick-tasks-header-icon'});
		setIcon(activeIcon, 'activity');
		activeHeader.createSpan({text: 'Active tasks'});

		let hasActive = false;

		// Current foreground session
		if (this.currentSessionId && this.isStreaming) {
			const name = this.sessionNames[this.currentSessionId]
				?.replace(/^\[(chat|inline|trigger(?::[a-z0-9-]+)?|search)\]\s*/, '') || 'Current session';
			const row = activeSection.createDiv({cls: 'sidekick-tasks-row'});
			row.createSpan({cls: 'sidekick-tasks-status sidekick-tasks-status-streaming', text: '●'});
			row.createSpan({cls: 'sidekick-tasks-name', text: name});
			row.createSpan({cls: 'sidekick-tasks-badge', text: 'streaming'});
			hasActive = true;
		}

		// Background sessions
		for (const [id, bg] of this.activeSessions) {
			if (id === this.currentSessionId) continue;
			const name = this.sessionNames[id]
				?.replace(/^\[(chat|inline|trigger(?::[a-z0-9-]+)?|search)\]\s*/, '') || `Session ${id.slice(0, 8)}`;
			const rawName = this.sessionNames[id] || '';
			const type = rawName.startsWith('[trigger]') || rawName.startsWith('[trigger:') ? 'trigger'
				: rawName.startsWith('[search]') ? 'search'
				: rawName.startsWith('[inline]') ? 'inline' : 'chat';
			const row = activeSection.createDiv({cls: 'sidekick-tasks-row sidekick-tasks-row-clickable'});
			row.createSpan({cls: `sidekick-tasks-status ${bg.isStreaming ? 'sidekick-tasks-status-streaming' : 'sidekick-tasks-status-idle'}`, text: '●'});
			row.createSpan({cls: 'sidekick-tasks-name', text: name});
			row.createSpan({cls: 'sidekick-tasks-badge sidekick-tasks-badge-type', text: type});
			row.createSpan({cls: 'sidekick-tasks-badge', text: bg.isStreaming ? 'streaming' : 'idle'});
			row.addEventListener('click', () => void this.selectSession(id));
			row.setAttribute('title', `Switch to ${name}`);
			hasActive = true;
		}

		if (!hasActive) {
			activeSection.createDiv({cls: 'sidekick-tasks-empty', text: 'No active tasks'});
		}

		// ── Recent sessions ───────────────────────────────────
		const recentCount = Math.min(this.sessionList.length, 10);
		if (recentCount > 0) {
			const recentSection = panel.createDiv({cls: 'sidekick-tasks-section'});
			const recentHeader = recentSection.createDiv({cls: 'sidekick-tasks-header'});
			const recentIcon = recentHeader.createSpan({cls: 'sidekick-tasks-header-icon'});
			setIcon(recentIcon, 'history');
			recentHeader.createSpan({text: `Recent sessions`});
			recentHeader.createSpan({cls: 'sidekick-tasks-count', text: `${this.sessionList.length}`});

			for (let i = 0; i < recentCount; i++) {
				const s = this.sessionList[i]!;
				const rawName = this.sessionNames[s.sessionId] || '';
				const displayName = rawName.replace(/^\[(chat|inline|trigger(?::[a-z0-9-]+)?|search)\]\s*/, '')
					|| `Session ${s.sessionId.slice(0, 8)}`;
				const typeIcon = rawName.startsWith('[trigger]') || rawName.startsWith('[trigger:') ? 'zap'
					: rawName.startsWith('[search]') ? 'search'
					: rawName.startsWith('[inline]') ? 'file-text' : 'message-square';
				const modTime = s.modifiedTime instanceof Date ? s.modifiedTime : new Date(s.modifiedTime);
				const ago = this.formatTimeAgo(modTime);
				const isActive = s.sessionId === this.currentSessionId;

				const row = recentSection.createDiv({cls: `sidekick-tasks-row sidekick-tasks-row-clickable${isActive ? ' sidekick-tasks-row-active' : ''}`});
				const ic = row.createSpan({cls: 'sidekick-tasks-type-icon'});
				setIcon(ic, typeIcon);
				row.createSpan({cls: 'sidekick-tasks-name', text: displayName});
				row.createSpan({cls: 'sidekick-tasks-time', text: ago});
				if (isActive) {
					row.createSpan({cls: 'sidekick-tasks-badge sidekick-tasks-badge-active', text: 'active'});
				}
				row.addEventListener('click', () => void this.selectSession(s.sessionId));
				row.setAttribute('title', `Switch to ${displayName}`);
			}
		}

		// ── Watching triggers ─────────────────────────────────
		const globTriggers = this.triggers.filter(t => t.enabled && t.glob);
		const cronTriggers = this.triggers.filter(t => t.enabled && t.cron);
		if (globTriggers.length > 0 || cronTriggers.length > 0) {
			const triggerSection = panel.createDiv({cls: 'sidekick-tasks-section'});
			const triggerHeader = triggerSection.createDiv({cls: 'sidekick-tasks-header'});
			const triggerIcon = triggerHeader.createSpan({cls: 'sidekick-tasks-header-icon'});
			setIcon(triggerIcon, 'zap');
			triggerHeader.createSpan({text: 'Watching triggers'});

			for (const t of globTriggers) {
				const key = `file:${t.name}`;
				const lastTs = this.plugin.settings.triggerLastFired?.[key];
				const lastInfo = lastTs ? this.formatTimeAgo(new Date(lastTs)) : 'never';

				const row = triggerSection.createDiv({cls: 'sidekick-tasks-row'});
				const ic = row.createSpan({cls: 'sidekick-tasks-type-icon'});
				setIcon(ic, 'zap');
				row.createSpan({cls: 'sidekick-tasks-name', text: t.name});
				const detail = row.createSpan({cls: 'sidekick-tasks-detail'});
				detail.createEl('code', {text: t.glob});
				row.createSpan({cls: 'sidekick-tasks-time', text: `fired ${lastInfo}`});
			}
			for (const t of cronTriggers) {
				const lastTs = this.plugin.settings.triggerLastFired?.[t.name];
				const lastInfo = lastTs ? this.formatTimeAgo(new Date(lastTs)) : 'never';

				const row = triggerSection.createDiv({cls: 'sidekick-tasks-row'});
				const ic = row.createSpan({cls: 'sidekick-tasks-type-icon'});
				setIcon(ic, 'clock');
				row.createSpan({cls: 'sidekick-tasks-name', text: t.name});
				const detail = row.createSpan({cls: 'sidekick-tasks-detail'});
				detail.createEl('code', {text: t.cron!});
				row.createSpan({cls: 'sidekick-tasks-time', text: `fired ${lastInfo}`});
			}
		}

		this.scrollToBottom();
	};
}
