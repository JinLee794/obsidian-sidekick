import {
	App,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Notice,
	normalizePath,
	setIcon,
	TFile,
	TFolder,
	FuzzySuggestModal,
	Component,
	Menu,
} from 'obsidian';
import type SidekickPlugin from './main';
import {approveAll} from './copilot';
import type {
	CopilotSession,
	SessionConfig,
	MCPServerConfig,
	ModelInfo,
	MessageOptions,
} from './copilot';
import type {AgentConfig, SkillInfo, McpServerEntry, ChatMessage, ChatAttachment} from './types';
import {loadAgents, loadSkills, loadMcpServers} from './configLoader';
import {VaultScopeModal} from './vaultScopeModal';

export const SIDEKICK_VIEW_TYPE = 'sidekick-view';

// ── File-attach modal ───────────────────────────────────────────

class FileAttachModal extends FuzzySuggestModal<TFile> {
	private readonly onSelect: (file: TFile) => void;

	constructor(app: App, onSelect: (file: TFile) => void) {
		super(app);
		this.onSelect = onSelect;
		this.setPlaceholder('Search vault files…');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles();
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onSelect(item);
	}
}

// ── Sidekick view ───────────────────────────────────────────────

export class SidekickView extends ItemView {
	plugin: SidekickPlugin;

	// ── State ────────────────────────────────────────────────────
	private messages: ChatMessage[] = [];
	private currentSession: CopilotSession | null = null;
	private agents: AgentConfig[] = [];
	private models: ModelInfo[] = [];
	private skills: SkillInfo[] = [];
	private mcpServers: McpServerEntry[] = [];

	private selectedAgent = '';
	private selectedModel = '';
	private enabledSkills: Set<string> = new Set();
	private enabledMcpServers: Set<string> = new Set();
	private attachments: ChatAttachment[] = [];
	private scopePaths: string[] = [];

	private isStreaming = false;
	private configDirty = true;
	private streamingContent = '';
	private renderScheduled = false;

	// ── DOM refs ─────────────────────────────────────────────────
	private chatContainer!: HTMLElement;
	private streamingBodyEl: HTMLElement | null = null;
	private toolStatusEl: HTMLElement | null = null;
	private inputEl!: HTMLTextAreaElement;
	private attachmentsBar!: HTMLElement;
	private scopeBar!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private agentSelect!: HTMLSelectElement;
	private modelSelect!: HTMLSelectElement;
	private skillsBtnEl!: HTMLButtonElement;
	private toolsBtnEl!: HTMLButtonElement;
	private streamingComponent: Component | null = null;

	private eventUnsubscribers: (() => void)[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: SidekickPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SIDEKICK_VIEW_TYPE;
	}
	getDisplayText(): string {
		return 'Sidekick';
	}
	getIcon(): string {
		return 'brain';
	}

	// ── Lifecycle ────────────────────────────────────────────────

	async onOpen(): Promise<void> {
		// Header actions
		this.addAction('refresh-cw', 'Refresh configuration', () => void this.loadAllConfigs());
		this.addAction('plus', 'New conversation', () => void this.newConversation());

		this.buildUI();
		await this.loadAllConfigs();
	}

	async onClose(): Promise<void> {
		await this.destroySession();
	}

	// ── UI construction ──────────────────────────────────────────

	private buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('sidekick-root');

		// Chat history (scrollable)
		this.chatContainer = root.createDiv({cls: 'sidekick-chat'});
		this.renderWelcome();

		// Bottom panel
		const bottom = root.createDiv({cls: 'sidekick-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);
	}

	private renderWelcome(): void {
		const welcome = this.chatContainer.createDiv({cls: 'sidekick-welcome'});
		const icon = welcome.createDiv({cls: 'sidekick-welcome-icon'});
		setIcon(icon, 'brain');
		welcome.createEl('h3', {text: 'Sidekick'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, and start chatting.',
			cls: 'sidekick-welcome-desc',
		});
	}

	private buildInputArea(parent: HTMLElement): void {
		const inputArea = parent.createDiv({cls: 'sidekick-input-area'});

		// Attach buttons row above textarea
		const inputActions = inputArea.createDiv({cls: 'sidekick-input-actions'});

		const attachBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'Attach file'}});
		setIcon(attachBtn, 'paperclip');
		attachBtn.addEventListener('click', () => this.handleAttachFile());

		const clipBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'Paste clipboard'}});
		setIcon(clipBtn, 'clipboard-paste');
		clipBtn.addEventListener('click', () => void this.handleClipboard());

		// Attachments & scope (shown inline after action buttons)
		this.attachmentsBar = inputActions.createDiv({cls: 'sidekick-attachments-bar'});
		this.scopeBar = inputActions.createDiv({cls: 'sidekick-scope-bar'});

		// Row for textarea + send button
		const inputRow = inputArea.createDiv({cls: 'sidekick-input-row'});

		this.inputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-input',
			attr: {placeholder: 'Describe what to build next…', rows: '1'},
		});

		// Auto-resize
		this.inputEl.addEventListener('input', () => {
			this.inputEl.style.height = 'auto';
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
		});

		// Enter to send, Shift+Enter for newline
		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {
				e.preventDefault();
				void this.handleSend();
			}
		});

		// Paste handler for images
		this.inputEl.addEventListener('paste', (e: ClipboardEvent) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item && item.type.startsWith('image/')) {
					e.preventDefault();
					const blob = item.getAsFile();
					if (blob) void this.handleImagePaste(blob);
					return;
				}
			}
		});

		// Send / Stop button
		this.sendBtn = inputRow.createEl('button', {
			cls: 'clickable-icon sidekick-send-btn',
			attr: {'aria-label': 'Send message'},
		});
		setIcon(this.sendBtn, 'arrow-up');
		this.sendBtn.addEventListener('click', () => {
			if (this.isStreaming) {
				void this.handleAbort();
			} else {
				void this.handleSend();
			}
		});
	}

	private buildConfigToolbar(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'sidekick-toolbar'});

		// Refresh button
		const refreshBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'Refresh configuration'}});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => void this.loadAllConfigs());

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectedAgent = this.agentSelect.value;
			// Auto-select agent's preferred model
			const agent = this.agents.find(a => a.name === this.selectedAgent);
			if (agent?.model) {
				const modelMatch = this.models.find(
					m => m.name.toLowerCase() === agent.model!.toLowerCase() ||
					     m.id.toLowerCase() === agent.model!.toLowerCase()
				);
				if (modelMatch) {
					this.selectedModel = modelMatch.id;
					this.modelSelect.value = modelMatch.id;
				}
			}
			this.configDirty = true;
		});

		// Model dropdown
		const modelGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.modelSelect = modelGroup.createEl('select', {cls: 'sidekick-select'});
		this.modelSelect.addEventListener('change', () => {
			this.selectedModel = this.modelSelect.value;
			this.configDirty = true;
		});

		// Skills button
		this.skillsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'Skills'}});
		setIcon(this.skillsBtnEl, 'wand-2');
		this.skillsBtnEl.addEventListener('click', (e) => this.openSkillsMenu(e));

		// Tools button
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'Tools'}});
		setIcon(this.toolsBtnEl, 'plug');
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));

		// Vault scope button
		const scopeBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {'aria-label': 'Select vault scope'}});
		setIcon(scopeBtn, 'folder');
		scopeBtn.addEventListener('click', () => this.openScopeModal());
	}

	// ── Config loading ───────────────────────────────────────────

	private async loadAllConfigs(): Promise<void> {
		try {
			this.agents = await loadAgents(this.app, this.plugin.settings.agentsFolder);
			this.skills = await loadSkills(this.app, this.plugin.settings.skillsFolder);
			this.mcpServers = await loadMcpServers(this.app, this.plugin.settings.toolsFolder);

			// Select all skills and tools by default
			this.enabledSkills = new Set(this.skills.map(s => s.name));
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));

			if (this.plugin.copilot) {
				try {
					this.models = await this.plugin.copilot.listModels();
				} catch (e) {
					console.warn('Sidekick: failed to load models', e);
				}
			}
		} catch (e) {
			console.error('Sidekick: failed to load configs', e);
		}

		this.updateConfigUI();
		this.configDirty = true;
		new Notice(`Loaded ${this.agents.length} agent(s), ${this.models.length} model(s), ${this.skills.length} skill(s), ${this.mcpServers.length} tool server(s).`);
	}

	private updateConfigUI(): void {
		// Agents
		this.agentSelect.empty();
		const noAgent = this.agentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.agentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
		}
		if (this.selectedAgent && this.agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
		} else if (this.agents.length > 0 && this.agents[0]) {
			this.selectedAgent = this.agents[0].name;
			this.agentSelect.value = this.selectedAgent;
		}

		// Models
		this.modelSelect.empty();
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
		}

		// Update skill / tool button badges
		this.updateSkillsBadge();
		this.updateToolsBadge();
	}

	private openSkillsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.enabledSkills.has(skill.name))
						.onClick(() => {
							if (this.enabledSkills.has(skill.name)) {
								this.enabledSkills.delete(skill.name);
							} else {
								this.enabledSkills.add(skill.name);
							}
							this.configDirty = true;
							this.updateSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	private openToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.enabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.enabledMcpServers.has(server.name)) {
								this.enabledMcpServers.delete(server.name);
							} else {
								this.enabledMcpServers.add(server.name);
							}
							this.configDirty = true;
							this.updateToolsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	private updateSkillsBadge(): void {
		const count = this.enabledSkills.size;
		this.skillsBtnEl.toggleClass('is-active', count > 0);
		this.skillsBtnEl.setAttribute('aria-label', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	private updateToolsBadge(): void {
		const count = this.enabledMcpServers.size;
		this.toolsBtnEl.toggleClass('is-active', count > 0);
		this.toolsBtnEl.setAttribute('aria-label', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	// ── Attachments & scope ──────────────────────────────────────

	private renderAttachments(): void {
		this.attachmentsBar.empty();
		if (this.attachments.length === 0) {
			this.attachmentsBar.addClass('is-hidden');
			return;
		}
		this.attachmentsBar.removeClass('is-hidden');

		for (let i = 0; i < this.attachments.length; i++) {
			const att = this.attachments[i];
			if (!att) continue;
			const tag = this.attachmentsBar.createDiv({cls: 'sidekick-attachment-tag'});
			const typeIcon = att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : 'file-text';
			const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, typeIcon);
			tag.createSpan({text: att.name, cls: 'sidekick-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'sidekick-attachment-remove'});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
			});
		}
	}

	private renderScopeBar(): void {
		this.scopeBar.empty();
		if (this.scopePaths.length === 0) {
			this.scopeBar.addClass('is-hidden');
			return;
		}
		this.scopeBar.removeClass('is-hidden');

		const label = this.scopeBar.createSpan({cls: 'sidekick-scope-label'});
		setIcon(label, 'folder-tree');
		label.appendText(` ${this.scopePaths.length} item(s) in scope`);
		label.style.cursor = 'pointer';
		label.addEventListener('click', (e) => {
			const menu = new Menu();
			for (const p of this.scopePaths) {
				const display = p === '/' ? this.app.vault.getName() : p;
				menu.addItem(item => item.setTitle(display).setDisabled(true));
			}
			menu.showAtMouseEvent(e);
		});

		const removeBtn = this.scopeBar.createSpan({cls: 'sidekick-scope-remove'});
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', () => {
			this.scopePaths = [];
			this.renderScopeBar();
		});
	}

	private handleAttachFile(): void {
		new FileAttachModal(this.app, (file: TFile) => {
			this.attachments.push({type: 'file', name: file.name, path: file.path});
			this.renderAttachments();
		}).open();
	}

	private async handleClipboard(): Promise<void> {
		try {
			const text = await navigator.clipboard.readText();
			if (!text.trim()) {
				new Notice('Clipboard is empty.');
				return;
			}
			const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
			this.attachments.push({type: 'clipboard', name: `Clipboard: ${preview}`, content: text});
			this.renderAttachments();
		} catch (e) {
			new Notice(`Failed to read clipboard: ${String(e)}`);
		}
	}

	private async handleImagePaste(blob: File): Promise<void> {
		try {
			const buffer = await blob.arrayBuffer();
			const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
			const name = `paste-${Date.now()}.${ext}`;
			const folder = normalizePath('.sidekick-attachments');

			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder);
			}

			const filePath = normalizePath(`${folder}/${name}`);
			await this.app.vault.adapter.writeBinary(filePath, buffer);

			this.attachments.push({type: 'image', name, path: filePath});
			this.renderAttachments();
			new Notice('Image attached.');
		} catch (e) {
			new Notice(`Failed to attach image: ${String(e)}`);
		}
	}

	private openScopeModal(): void {
		new VaultScopeModal(this.app, this.scopePaths, (paths) => {
			this.scopePaths = paths;
			this.renderScopeBar();
		}).open();
	}

	// ── Message rendering ────────────────────────────────────────

	private addUserMessage(content: string, attachments: ChatAttachment[]): void {
		const msg: ChatMessage = {
			id: `u-${Date.now()}`,
			role: 'user',
			content,
			timestamp: Date.now(),
			attachments: attachments.length > 0 ? attachments : undefined,
		};
		this.messages.push(msg);
		this.renderMessageBubble(msg);
		this.scrollToBottom();
	}

	private addInfoMessage(text: string): void {
		const msg: ChatMessage = {id: `i-${Date.now()}`, role: 'info', content: text, timestamp: Date.now()};
		this.messages.push(msg);
		this.renderMessageBubble(msg);
		this.scrollToBottom();
	}

	private renderMessageBubble(msg: ChatMessage): void {
		if (msg.role === 'info') {
			const el = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-info'});
			el.createSpan({text: msg.content});
			return;
		}

		const wrapper = this.chatContainer.createDiv({
			cls: `sidekick-msg sidekick-msg-${msg.role}`,
		});

		const bodyWrapper = wrapper.createDiv({cls: 'sidekick-msg-body-wrapper'});

		// Attachments
		if (msg.attachments && msg.attachments.length > 0) {
			const attRow = bodyWrapper.createDiv({cls: 'sidekick-msg-attachments'});
			for (const att of msg.attachments) {
				const chip = attRow.createSpan({cls: 'sidekick-msg-att-chip'});
				const ic = chip.createSpan();
				setIcon(ic, att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : 'file-text');
				chip.appendText(` ${att.name}`);
			}
		}

		const body = bodyWrapper.createDiv({cls: 'sidekick-msg-body'});

		if (msg.role === 'assistant') {
			void this.renderMarkdownSafe(msg.content, body);
		} else {
			body.createEl('p', {text: msg.content});
			// Copy button for user messages
			const copyBtn = wrapper.createEl('button', {
				cls: 'sidekick-msg-copy',
				attr: {title: 'Copy to clipboard'},
			});
			setIcon(copyBtn, 'copy');
			copyBtn.addEventListener('click', () => {
				void navigator.clipboard.writeText(msg.content);
				setIcon(copyBtn, 'check');
				setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			});
		}
	}

	private addAssistantPlaceholder(): void {
		const wrapper = this.chatContainer.createDiv({cls: 'sidekick-msg sidekick-msg-assistant'});

		const bodyWrapper = wrapper.createDiv({cls: 'sidekick-msg-body-wrapper'});

		// Tool status element
		this.toolStatusEl = bodyWrapper.createDiv({cls: 'sidekick-tool-status is-hidden'});

		const body = bodyWrapper.createDiv({cls: 'sidekick-msg-body'});
		const thinking = body.createDiv({cls: 'sidekick-thinking'});
		thinking.createSpan({text: 'Thinking'});
		thinking.createSpan({cls: 'sidekick-thinking-dots', text: '...'});

		// Clean up any previous streaming component
		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}
		this.streamingComponent = this.addChild(new Component());

		this.streamingBodyEl = body;
		this.scrollToBottom();
	}

	// ── Streaming ────────────────────────────────────────────────

	private appendDelta(delta: string): void {
		this.streamingContent += delta;
		if (!this.renderScheduled) {
			this.renderScheduled = true;
			window.requestAnimationFrame(() => {
				this.renderScheduled = false;
				void this.updateStreamingRender();
			});
		}
	}

	private async updateStreamingRender(): Promise<void> {
		if (!this.streamingBodyEl) return;
		this.streamingBodyEl.empty();
		await this.renderMarkdownSafe(this.streamingContent, this.streamingBodyEl);
		this.scrollToBottom();
	}

	private finalizeStreamingMessage(): void {
		if (this.streamingContent) {
			const msg: ChatMessage = {
				id: `a-${Date.now()}`,
				role: 'assistant',
				content: this.streamingContent,
				timestamp: Date.now(),
			};
			this.messages.push(msg);
		}

		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.toolStatusEl = null;

		if (this.streamingComponent) {
			this.removeChild(this.streamingComponent);
			this.streamingComponent = null;
		}

		this.isStreaming = false;
		this.updateSendButton();
	}

	private showToolStatus(toolName: string): void {
		if (!this.toolStatusEl) return;
		this.toolStatusEl.removeClass('is-hidden');
		this.toolStatusEl.empty();
		const ic = this.toolStatusEl.createSpan({cls: 'sidekick-tool-icon'});
		setIcon(ic, 'wrench');
		this.toolStatusEl.createSpan({text: `Using ${toolName}…`});
	}

	private hideToolStatus(): void {
		if (!this.toolStatusEl) return;
		this.toolStatusEl.addClass('is-hidden');
	}

	private updateSendButton(): void {
		this.sendBtn.empty();
		if (this.isStreaming) {
			setIcon(this.sendBtn, 'square');
			this.sendBtn.ariaLabel = 'Stop';
			this.sendBtn.addClass('is-streaming');
		} else {
			setIcon(this.sendBtn, 'arrow-up');
			this.sendBtn.ariaLabel = 'Send message';
			this.sendBtn.removeClass('is-streaming');
		}
	}

	// ── Send & abort ─────────────────────────────────────────────

	private async handleSend(): Promise<void> {
		const prompt = this.inputEl.value.trim();
		if (!prompt || this.isStreaming) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured. Go to Settings → Sidekick.');
			return;
		}

		// Snapshot attachments
		const currentAttachments = [...this.attachments];

		// Update UI
		this.addUserMessage(prompt, currentAttachments);
		this.inputEl.value = '';
		this.inputEl.style.height = 'auto';
		this.attachments = [];
		this.renderAttachments();

		// Begin streaming
		this.isStreaming = true;
		this.streamingContent = '';
		this.updateSendButton();
		this.addAssistantPlaceholder();

		try {
			await this.ensureSession();

			const sdkAttachments = this.buildSdkAttachments(currentAttachments);
			const fullPrompt = this.buildPrompt(prompt, currentAttachments);

			await this.currentSession!.send({
				prompt: fullPrompt,
				...(sdkAttachments && sdkAttachments.length > 0 ? {attachments: sdkAttachments} : {}),
			});
		} catch (e) {
			this.finalizeStreamingMessage();
			this.addInfoMessage(`Error: ${String(e)}`);
		}
	}

	private async handleAbort(): Promise<void> {
		if (this.currentSession) {
			try {
				await this.currentSession.abort();
			} catch { /* ignore */ }
		}
		this.finalizeStreamingMessage();
		this.addInfoMessage('Response stopped.');
	}

	// ── Session management ───────────────────────────────────────

	private async ensureSession(): Promise<void> {
		if (this.currentSession && !this.configDirty) return;

		// Tear down existing session
		if (this.currentSession) {
			this.unsubscribeEvents();
			try {
				await this.currentSession.destroy();
			} catch { /* ignore */ }
			this.currentSession = null;
		}

		const agent = this.agents.find(a => a.name === this.selectedAgent);
		const model = this.selectedModel || undefined;

		// System message from agent instructions
		let systemContent = '';
		if (agent?.instructions) {
			systemContent = agent.instructions;
		}

		// MCP servers
		const mcpServers: Record<string, MCPServerConfig> = {};
		for (const server of this.mcpServers) {
			if (!this.enabledMcpServers.has(server.name)) continue;
			const cfg = server.config;
			const serverType = cfg['type'] as string | undefined;
			if (serverType === 'http' || serverType === 'sse') {
				mcpServers[server.name] = {
					type: serverType,
					url: cfg['url'] as string,
					tools: ['*'],
					...(cfg['headers'] ? {headers: cfg['headers'] as Record<string, string>} : {}),
				};
			} else if (cfg['command']) {
				mcpServers[server.name] = {
					type: 'local',
					command: cfg['command'] as string,
					args: (cfg['args'] as string[] | undefined) ?? [],
					tools: ['*'],
				};
			}
		}

		// Skills directories
		const basePath = this.getVaultBasePath();
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push(basePath + '/' + normalizePath(this.plugin.settings.skillsFolder));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		const sessionConfig: SessionConfig = {
			model,
			streaming: true,
			onPermissionRequest: approveAll,
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(systemContent ? {systemMessage: {mode: 'append' as const, content: systemContent}} : {}),
		};

		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig);
		this.configDirty = false;
		this.registerSessionEvents();
	}

	private registerSessionEvents(): void {
		if (!this.currentSession) return;
		const session = this.currentSession;

		this.eventUnsubscribers.push(
			session.on('assistant.message_delta', (event) => {
				this.appendDelta(event.data.deltaContent);
			}),
			session.on('assistant.message', () => {
				// Content already accumulated via deltas
			}),
			session.on('session.idle', () => {
				this.finalizeStreamingMessage();
			}),
			session.on('session.error', (event) => {
				this.finalizeStreamingMessage();
				this.addInfoMessage(`Error: ${event.data.message}`);
			}),
			session.on('tool.execution_start', (event) => {
				this.showToolStatus(event.data.toolName);
			}),
			session.on('tool.execution_complete', () => {
				this.hideToolStatus();
			}),
		);
	}

	private unsubscribeEvents(): void {
		for (const unsub of this.eventUnsubscribers) unsub();
		this.eventUnsubscribers = [];
	}

	private async destroySession(): Promise<void> {
		this.unsubscribeEvents();
		if (this.currentSession) {
			try {
				await this.currentSession.destroy();
			} catch { /* ignore */ }
			this.currentSession = null;
		}
	}

	private async newConversation(): Promise<void> {
		await this.destroySession();
		this.messages = [];
		this.streamingContent = '';
		this.streamingBodyEl = null;
		this.isStreaming = false;
		this.configDirty = true;
		this.attachments = [];
		this.scopePaths = [];

		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.renderScopeBar();
		this.updateSendButton();
	}

	// ── Prompt & attachment building ─────────────────────────────

	private buildPrompt(basePrompt: string, attachments: ChatAttachment[]): string {
		let prompt = basePrompt;
		const clipboards = attachments.filter(a => a.type === 'clipboard');
		for (const clip of clipboards) {
			if (clip.content) {
				prompt += `\n\n---\nClipboard content:\n${clip.content}`;
			}
		}
		return prompt;
	}

	private buildSdkAttachments(attachments: ChatAttachment[]): MessageOptions['attachments'] {
		const basePath = this.getVaultBasePath();
		const result: NonNullable<MessageOptions['attachments']> = [];

		for (const att of attachments) {
			if ((att.type === 'file' || att.type === 'image') && att.path) {
				result.push({
					type: 'file',
					path: basePath + '/' + normalizePath(att.path),
					displayName: att.name,
				});
			} else if (att.type === 'directory' && att.path) {
				result.push({
					type: 'directory',
					path: basePath + '/' + normalizePath(att.path),
					displayName: att.name,
				});
			}
		}

		// Add vault scope paths
		for (const scopePath of this.scopePaths) {
			const absPath = basePath + '/' + normalizePath(scopePath);
			const abstract = this.app.vault.getAbstractFileByPath(scopePath);
			if (abstract instanceof TFolder) {
				result.push({type: 'directory', path: absPath, displayName: scopePath});
			} else if (abstract instanceof TFile) {
				result.push({type: 'file', path: absPath, displayName: scopePath});
			}
		}

		return result.length > 0 ? result : undefined;
	}

	// ── Utilities ────────────────────────────────────────────────

	private getVaultBasePath(): string {
		return (this.app.vault.adapter as unknown as {basePath: string}).basePath;
	}

	private scrollToBottom(): void {
		// Only auto-scroll if user is near the bottom
		const threshold = 100;
		const isNear = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight < threshold;
		if (isNear) {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		}
	}

	private async renderMarkdownSafe(content: string, container: HTMLElement): Promise<void> {
		try {
			const component = this.streamingComponent ?? this;
			await MarkdownRenderer.render(this.app, content, container, '', component);
		} catch {
			// Fallback to plain text
			container.setText(content);
		}
	}
}
