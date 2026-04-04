import {Component, Notice, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {PromptConfig} from '../types';
import {debugTrace} from '../debug';
import {buildPrompt, buildSdkAttachments} from './sessionConfig';
import {enrichServersWithAzureAuth} from '../mcpProbe';

export function installChatSession(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	// ── Subagent blocks ──────────────────────────────────────────

	proto.addSubagentBlock = function(toolCallId: string, agentName: string, _status: string, description?: string): void {
		if (!this.toolCallsContainer) return;

		const block = this.toolCallsContainer.createDiv({cls: 'sidekick-subagent-block'});
		const header = block.createDiv({cls: 'sidekick-subagent-header'});
		const iconEl = header.createSpan({cls: 'sidekick-subagent-icon'});
		setIcon(iconEl, 'bot');
		header.createSpan({cls: 'sidekick-subagent-name', text: agentName});
		const spinner = header.createSpan({cls: 'sidekick-subagent-spinner'});
		setIcon(spinner, 'loader');

		if (description) {
			block.createDiv({cls: 'sidekick-subagent-desc', text: description});
		}

		// Collapsible activity section — tool calls from this sub-agent render here
		const activityDetails = block.createEl('details', {cls: 'sidekick-subagent-activity-wrapper'});
		const activitySummary = activityDetails.createEl('summary', {cls: 'sidekick-subagent-activity-summary'});
		activitySummary.createSpan({text: 'Activity'});
		const countBadge = activitySummary.createSpan({cls: 'sidekick-subagent-activity-count', text: '0'});
		countBadge.setAttribute('data-count', '0');
		activityDetails.createDiv({cls: 'sidekick-subagent-activity'});

		this.activeSubagentBlocks.set(toolCallId, block);
		this.scrollToBottom();
	};

	proto.updateSubagentBlock = function(toolCallId: string, status: 'completed' | 'failed', error?: string): void {
		const block = this.activeSubagentBlocks.get(toolCallId);
		if (!block) return;

		// Remove spinner
		const spinner = block.querySelector('.sidekick-subagent-spinner');
		if (spinner) spinner.remove();

		const header = block.querySelector('.sidekick-subagent-header');
		if (header) {
			const statusEl = (header as HTMLElement).createSpan({
				cls: `sidekick-subagent-status ${status === 'completed' ? 'is-success' : 'is-error'}`,
			});
			setIcon(statusEl, status === 'completed' ? 'check' : 'x');
		}

		if (status === 'failed' && error) {
			block.createDiv({cls: 'sidekick-subagent-error', text: `Error: ${error}`});
		}

		block.toggleClass('is-completed', status === 'completed');
		block.toggleClass('is-failed', status === 'failed');
		this.activeSubagentBlocks.delete(toolCallId);
		this.scrollToBottom();
	};

	// ── Send & abort ─────────────────────────────────────────────

	proto.handleSend = async function(): Promise<void> {
		const rawInput = this.inputEl.value.trim();
		if (!rawInput || this.isStreaming) return;

		// Lock immediately to prevent duplicate submissions from rapid clicks
		this.isStreaming = true;
		this.updateSendButton();

		// Close dropdowns
		this.closePromptDropdown();
		this.closeAgentDropdown();

		// Handle built-in slash commands (no copilot needed)
		if (rawInput.startsWith('/')) {
			const spaceIdx = rawInput.indexOf(' ');
			const cmdName = spaceIdx > 0 ? rawInput.slice(1, spaceIdx) : rawInput.slice(1);
			const cmdArg = spaceIdx > 0 ? rawInput.slice(spaceIdx + 1).trim() : undefined;
			const isBuiltin = (this.constructor as typeof import('../sidekickView').SidekickView).BUILTIN_COMMANDS.some(c => c.name === cmdName);
			if (isBuiltin) {
				this.isStreaming = false;
				this.updateSendButton();
				this.inputEl.value = '';
				this.inputEl.setCssProps({'--input-height': 'auto'});
				this.executeBuiltinCommand(cmdName, cmdArg);
				return;
			}
		}

		if (!this.plugin.copilot) {
			this.isStreaming = false;
			this.updateSendButton();
			new Notice('Copilot is not configured.');
			return;
		}

		// Resolve @agent mention: extract agent name and strip from prompt
		let mentionedAgent: string | null = null;
		let inputWithoutMention = rawInput;
		const agentMentionMatch = rawInput.match(/^@(\S+)\s+/);
		if (agentMentionMatch) {
			const mentionName = agentMentionMatch[1]!;
			const agent = this.agents.find(a => a.name.toLowerCase() === mentionName.toLowerCase());
			if (agent) {
				mentionedAgent = agent.name;
				inputWithoutMention = rawInput.slice(agentMentionMatch[0].length);
			}
		}

		// Resolve prompt command: strip /prompt-name prefix, extract user text
		let prompt = inputWithoutMention;
		let usedPrompt: PromptConfig | null = this.activePrompt;

		if (inputWithoutMention.startsWith('/')) {
			const spaceIdx = inputWithoutMention.indexOf(' ');
			if (spaceIdx > 0) {
				const cmdName = inputWithoutMention.slice(1, spaceIdx);
				const found = this.prompts.find(p => p.name === cmdName);
				if (found) {
					usedPrompt = found;
					prompt = inputWithoutMention.slice(spaceIdx + 1).trim();
				}
			}
		}

		// Apply the @agent mention: switch agent for this message
		if (mentionedAgent) {
			this.selectAgent(mentionedAgent);
		}

		// Display prompt (show original input to user)
		const displayPrompt = rawInput;

		// Snapshot attachments and scope
		const currentAttachments = [...this.attachments];
		// Legacy mode: preserve automatic active-note/selection inclusion.
		if (this.plugin.settings.contextMode === 'auto') {
			if (this.activeSelection && !currentAttachments.some(a => a.type === 'selection' && a.path === this.activeSelection!.filePath && !a.absolutePath)) {
				const sel = this.activeSelection;
				const displayName = sel.startLine === sel.endLine
					? `${sel.fileName}:${sel.startLine}`
					: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
				currentAttachments.push({
					type: 'selection',
					name: displayName,
					path: sel.filePath,
					content: sel.text,
					selection: {
						startLine: sel.startLine,
						startChar: sel.startChar,
						endLine: sel.endLine,
						endChar: sel.endChar,
					},
				});
			} else if (this.activeNotePath && !currentAttachments.some(a => (a.type === 'file' || a.type === 'selection') && a.path === this.activeNotePath && !a.absolutePath)) {
				const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
				currentAttachments.push({type: 'file', name, path: this.activeNotePath});
			}
		}
		const currentScopePaths = [...this.scopePaths];

		// Auto-select agent from prompt if specified
		if (usedPrompt?.agent) {
			this.selectAgent(usedPrompt.agent);
		}

		// When a prompt slash command is used, skip skills so the agent
		// executes the prompt template directly (applied at session creation).
		const skipSkills = !!usedPrompt;

		// Prepend prompt template content if active.
		// Include an explicit instruction to not invoke skills so the model
		// follows the prompt template even on sessions that already have skills.
		const sendPrompt = usedPrompt
			? `${usedPrompt.content}\n\nDo not invoke any skills for this request. Respond directly based on the instructions above.\n\n${prompt}`
			: prompt;

		this.activePrompt = null;
		this.inputEl.removeAttribute('title');

		// Update UI immediately so the user sees feedback before any async work
		this.addUserMessage(displayPrompt, currentAttachments, currentScopePaths);
		this.inputEl.value = '';
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.attachments = [];
		this.renderAttachments();
		this.rebuildSuggestions(false);
		this.renderActiveNoteBar();

		// Begin streaming
		this.streamingContent = '';
		this.updateSendButton();
		this.renderSessionList();  // Show green active dot
		this.addAssistantPlaceholder();

		// Agent triage (async) — runs after UI is already updated
		if (this.plugin.settings.agentTriage && !this.selectedAgent && this.agents.length > 1) {
			if (!this.triageAgentForSession) {
				const routed = await this.triageRequest(sendPrompt);
				if (routed) {
					this.triageAgentForSession = routed;
					this.configDirty = true;
					this.addInfoMessage(`Routed to **${routed}**.`);
				}
			}
		}

		try {
			await this.ensureSession({skipSkills});

			const effectiveAgentName = this.selectedAgent || this.triageAgentForSession || '';

			// Name the session if this is the first message
			if (this.currentSessionId && !this.sessionNames[this.currentSessionId]) {
				const agentName = effectiveAgentName || 'Chat';
				const truncated = prompt.length > 40 ? prompt.slice(0, 40) + '…' : prompt;
				this.sessionNames[this.currentSessionId] = `[chat] ${agentName}: ${truncated}`;
				this.saveSessionNames();
				this.renderSessionList();
			}

			const sdkAttachments = buildSdkAttachments({
				attachments: currentAttachments,
				scopePaths: currentScopePaths,
				vaultBasePath: this.getVaultBasePath(),
				app: this.app,
			});
			let fullPrompt = buildPrompt(sendPrompt, currentAttachments, this.cursorPosition, this.activeSelection);

			// Legacy mode: eager context building. Suggest mode relies on on-demand tools.
			if (this.plugin.settings.contextMode === 'auto' && this.contextBuilder && currentScopePaths.length > 0) {
				try {
					const context = await this.contextBuilder.buildContext({
						query: sendPrompt,
						scopePaths: currentScopePaths,
						maxChars: 8000,
						alreadySent: this.sessionContextPaths,
					});
					if (context.files.length > 0) {
						const excerptBlock = context.files.map(f =>
							`--- ${f.path} ---\n${f.excerpt}`
						).join('\n\n');
						fullPrompt = context.summary + '\n\n' + excerptBlock + '\n\n' + fullPrompt;
						for (const p of context.includedPaths) {
							this.sessionContextPaths.add(p);
						}
					}
				} catch { /* context building is best-effort */ }
			}

			try {
				await this.currentSession!.send({
					prompt: fullPrompt,
					...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
				});
			} catch (sendErr) {
				// If the session is stale (e.g. SDK restarted), invalidate and retry once
				if (String(sendErr).includes('Session not found')) {
					this.unsubscribeEvents();
					this.currentSession = null;
					this.currentSessionId = null;
					this.configDirty = true;
					await this.ensureSession({skipSkills});
					this.registerSessionEvents();
					await this.currentSession!.send({
						prompt: fullPrompt,
						...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
					});
				} else {
					throw sendErr;
				}
			}

		} catch (e) {
			this.finalizeStreamingMessage();
			// DEBUG: log full error with stack trace
			console.error('[sidekick] Send error:', e);
			if (e instanceof Error) {
				console.error('[sidekick] Stack:', e.stack);
			}
			this.addInfoMessage(`Error: ${String(e)}`);
		}
	};

	proto.handleAbort = async function(): Promise<void> {
		if (this.currentSession) {
			try {
				await this.currentSession.abort();
			} catch { /* ignore */ }
		}

		// If no content was streamed yet, replace "Thinking..." with "Cancelled"
		if (!this.streamingContent && this.streamingBodyEl) {
			this.streamingBodyEl.empty();
			this.streamingBodyEl.createDiv({cls: 'sidekick-thinking sidekick-cancelled', text: 'Cancelled'});
		}

		this.finalizeStreamingMessage();
	};

	// ── Session management ───────────────────────────────────────

	proto.ensureSession = async function(opts?: {skipSkills?: boolean}): Promise<void> {
		if (this.currentSession && !this.configDirty) return;

		// Tear down existing session
		if (this.currentSession) {
			this.unsubscribeEvents();
			try {
				await this.currentSession.disconnect();
			} catch { /* ignore */ }
			this.currentSession = null;
		}

		const effectiveAgentName = this.selectedAgent || this.triageAgentForSession || '';
		const agent = this.agents.find(a => a.name === effectiveAgentName);

		// Enrich Azure-authenticated MCP servers with fresh tokens before session creation
		await enrichServersWithAzureAuth(this.mcpServers, this.enabledMcpServers);

		const sessionConfig = this.buildSessionConfig({
			model: this.resolveModelForAgent(agent, this.selectedModel || undefined),
			selectedAgentName: effectiveAgentName || undefined,
			skipSkills: opts?.skipSkills,
		});

		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig);
		this.currentSessionId = this.currentSession.sessionId;
		this.configDirty = false;
		this.sessionContextPaths.clear();
		this.registerSessionEvents();
		this.updateToolbarLock();

		// Discover MCP tools now that session is created
		if (this.enabledMcpServers.size > 0) {
			this.scheduleMcpToolDiscovery();
		}

		// Add new session to list immediately so sidebar updates instantly
		if (!this.sessionList.some(s => s.sessionId === this.currentSession!.sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId: this.currentSession.sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as import('../copilot').SessionMetadata);
		}
		this.renderSessionList();
	};

	proto.registerSessionEvents = function(): void {
		if (!this.currentSession) return;
		const session = this.currentSession;

		this.eventUnsubscribers.push(
			session.on('assistant.turn_start', () => {
				// Only record start time on the first turn of a streaming response
				if (this.turnStartTime === 0) {
					this.turnStartTime = Date.now();
				}
			}),
			session.on('assistant.message_delta', (event) => {
				this.appendDelta(event.data.deltaContent);
			}),
			session.on('assistant.message', () => {
				// Content already accumulated via deltas
			}),
			session.on('assistant.usage', (event) => {
				const d = event.data;
				// Track the last event's input tokens separately (for context-window estimation,
				// excluding subagent accumulation)
				this.lastUsageInputTokens = (d.inputTokens ?? 0) + (d.cacheReadTokens ?? 0);
				// Accumulate usage across multiple calls in a turn
				if (!this.turnUsage) {
					this.turnUsage = {
						inputTokens: d.inputTokens ?? 0,
						outputTokens: d.outputTokens ?? 0,
						cacheReadTokens: d.cacheReadTokens ?? 0,
						cacheWriteTokens: d.cacheWriteTokens ?? 0,
						model: d.model,
					};
				} else {
					this.turnUsage.inputTokens += d.inputTokens ?? 0;
					this.turnUsage.outputTokens += d.outputTokens ?? 0;
					this.turnUsage.cacheReadTokens += d.cacheReadTokens ?? 0;
					this.turnUsage.cacheWriteTokens += d.cacheWriteTokens ?? 0;
					if (d.model) this.turnUsage.model = d.model;
				}
			}),
			session.on('session.idle', () => {
				this.finalizeStreamingMessage();
			}),
			session.on('session.error', (event) => {
				this.finalizeStreamingMessage();
				this.addInfoMessage(`Error: ${event.data.message}`);
			}),
			session.on('tool.execution_start', (event) => {
				this.turnToolsUsed.push(event.data.toolName);
				const parentId = (event.data as {parentToolCallId?: string}).parentToolCallId;
				const mcpServer = (event.data as {mcpServerName?: string}).mcpServerName;
				debugTrace('tool.execution_start', {
					toolCallId: event.data.toolCallId,
					toolName: event.data.toolName,
					parentToolCallId: parentId,
					mcpServerName: mcpServer,
				});
				// Track discovered MCP tools from session usage
				if (mcpServer) {
					this.trackDiscoveredTool(mcpServer, event.data.toolName);
				}
				this.addToolCallBlock(event.data.toolCallId, event.data.toolName, event.data.arguments, parentId);
				// Update sub-agent activity count
				if (parentId) {
					const subBlock = this.activeSubagentBlocks.get(parentId);
					if (subBlock) {
						const badge = subBlock.querySelector('.sidekick-subagent-activity-count');
						if (badge) {
							const count = parseInt(badge.getAttribute('data-count') || '0', 10) + 1;
							badge.setAttribute('data-count', String(count));
							badge.textContent = String(count);
						}
					}
				}
			}),
			session.on('tool.execution_complete', (event) => {
				debugTrace('tool.execution_complete', {
					toolCallId: event.data.toolCallId,
					success: event.data.success,
				});
				this.completeToolCallBlock(
					event.data.toolCallId,
					event.data.success,
					event.data.result as {content?: string; detailedContent?: string} | undefined,
					event.data.error as {message: string} | undefined,
				);
			}),
			session.on('skill.invoked', (event) => {
				this.turnSkillsUsed.push(event.data.name);
			}),
			session.on('subagent.started', (event) => {
				debugTrace('subagent.started', {
					toolCallId: event.data.toolCallId,
					agentName: event.data.agentName,
					agentDisplayName: event.data.agentDisplayName,
				});
				this.addSubagentBlock(event.data.toolCallId, event.data.agentDisplayName || event.data.agentName, 'started', event.data.agentDescription);
			}),
			session.on('subagent.completed', (event) => {
				debugTrace('subagent.completed', {
					toolCallId: event.data.toolCallId,
					agentName: event.data.agentName,
				});
				this.updateSubagentBlock(event.data.toolCallId, 'completed');
			}),
			session.on('subagent.failed', (event) => {
				debugTrace('subagent.failed', {
					toolCallId: event.data.toolCallId,
					agentName: event.data.agentName,
					error: event.data.error,
				});
				this.updateSubagentBlock(event.data.toolCallId, 'failed', event.data.error);
			}),
			session.on('session.info', (event) => {
				debugTrace('session.info', {infoType: event.data.infoType, message: event.data.message});
				this.handleMcpSessionEvent(event.data.infoType, event.data.message, 'info');
			}),
			session.on('session.warning', (event) => {
				debugTrace('session.warning', {warningType: event.data.warningType, message: event.data.message});
				this.handleMcpSessionEvent(event.data.warningType, event.data.message, 'warning');
			}),
			session.on('subagent.selected', (event) => {
				debugTrace('subagent.selected', {
					agentName: event.data.agentName,
					agentDisplayName: event.data.agentDisplayName,
					tools: event.data.tools,
				});
			}),
			session.on('subagent.deselected', () => {
				debugTrace('subagent.deselected', {});
			}),
		);
	};

	proto.unsubscribeEvents = function(): void {
		for (const unsub of this.eventUnsubscribers) unsub();
		this.eventUnsubscribers = [];
	};

	proto.disconnectSession = async function(): Promise<void> {
		this.unsubscribeEvents();
		if (this.currentSession) {
			try {
				await this.currentSession.disconnect();
			} catch { /* ignore */ }
			this.currentSession = null;
		}
	};

	proto.disconnectAllSessions = async function(): Promise<void> {
		await this.disconnectSession();
		for (const [, bg] of this.activeSessions) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
		}
		this.activeSessions.clear();
	};

	proto.newConversation = function(): void {
		// Save the current session to background instead of disconnecting it
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		} else {
			// No active session handle, just clean up
			this.unsubscribeEvents();
			this.currentSession = null;
		}
		this.currentSessionId = null;
		this.messages = [];
		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.streamingWrapperEl = null;
		this.toolCallsContainer = null;
		this.activeToolCalls.clear();
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.isStreaming = false;
		this.configDirty = true;
		this.attachments = [];
		this.scopePaths = [];
		this.triageAgentForSession = null;
		this.activePrompt = null;
		this.sessionInputTokens = 0;
		this.contextHintShown = false;
		this.inputEl.removeAttribute('title');
		this.clearMessageComponents();
		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.rebuildSuggestions(false);
		this.renderActiveNoteBar();
		this.renderScopeBar();
		this.updateSendButton();
		this.updateToolbarLock();
		this.renderSessionList();
	};
}
