import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	normalizePath,
	setIcon,
	Component,
	TFile,
	TFolder,
	Menu,
	MarkdownView,
	Modal,
} from 'obsidian';
import type SidekickPlugin from './main';
import {approveAll} from './copilot';
import type {
	CopilotSession,
	SessionConfig,
	SessionMetadata,
	MCPServerConfig,
	ModelInfo,
	MessageOptions,
	PermissionRequest,
	ProviderConfig,
	ReasoningEffort,
	CustomAgentConfig,
} from './copilot';
import type {AgentConfig, SkillInfo, McpServerEntry, McpInputVariable, PromptConfig, TriggerConfig, ChatMessage, ChatAttachment, SelectionInfo, ContextSuggestion} from './types';
import {loadAgents, loadSkills, loadMcpServers, loadPrompts, loadTriggers, loadInstructions} from './configLoader';
import type {InputResolver} from './configLoader';
import {getAgentsFolder, getSkillsFolder, getToolsFolder, getPromptsFolder, getTriggersFolder, getMcpInputValue, setMcpInputValue, McpInputPromptModal} from './settings';
import {TriggerScheduler} from './triggerScheduler';
import type {TriggerFireContext} from './triggerScheduler';
import {VaultIndex} from './vaultIndex';
import {ContextBuilder} from './contextBuilder';
import {VaultScopeModal} from './modals/vaultScopeModal';
import {EditModal} from './modals/editModal';
import {ToolApprovalModal} from './modals/toolApprovalModal';
import {FolderTreeModal} from './modals/folderTreeModal';
import {McpEditorModal} from './modals/mcpEditorModal';
import {AgentEditorModal} from './modals/agentEditorModal';
import type {AgentEditorContext} from './modals/agentEditorModal';
import {UserInputModal} from './modals/userInputModal';
import type {UserInputRequest} from './modals/userInputModal';
import {NewTriggerModal} from './triggerModal';
import {debugTrace, setDebugEnabled} from './debug';
import type {BackgroundSession} from './view/types';
import {mapMcpServers, buildSdkAttachments, buildPrompt} from './view/sessionConfig';

export const SIDEKICK_VIEW_TYPE = 'sidekick-view';

// ── Sidekick view ───────────────────────────────────────────────

export class SidekickView extends ItemView {
	plugin: SidekickPlugin;

	// ── State ────────────────────────────────────────────────────
	messages: ChatMessage[] = [];
	currentSession: CopilotSession | null = null;
	agents: AgentConfig[] = [];
	models: ModelInfo[] = [];
	skills: SkillInfo[] = [];
	mcpServers: McpServerEntry[] = [];
	/** Runtime MCP server status tracked from session.info/warning events. */
	mcpServerStatus = new Map<string, {status: 'pending' | 'connected' | 'error'; message?: string}>();
	prompts: PromptConfig[] = [];
	triggers: TriggerConfig[] = [];
	/** Concatenated content from *.instructions.md files, prepended to every session. */
	globalInstructions = '';
	triggerScheduler: TriggerScheduler | null = null;
	vaultIndex: VaultIndex | null = null;
	contextBuilder: ContextBuilder | null = null;
	sessionContextPaths = new Set<string>();
	activePrompt: PromptConfig | null = null;

	selectedAgent = '';
	selectedModel = '';
	enabledSkills: Set<string> = new Set();
	enabledMcpServers: Set<string> = new Set();
	attachments: ChatAttachment[] = [];
	suggestions: ContextSuggestion[] = [];
	activeNotePath: string | null = null;
	/** Live editor selection for the active note (null when no text is selected). */
	activeSelection: {filePath: string; fileName: string; text: string; startLine: number; startChar: number; endLine: number; endChar: number} | null = null;
	selectionPollTimer: ReturnType<typeof setInterval> | null = null;
	/** Whether the MarkdownView editor was focused on the previous poll tick. */
	editorHadFocus = false;
	/** Current cursor position in the active note (when no text is selected). */
	cursorPosition: {filePath: string; fileName: string; line: number; ch: number} | null = null;
	scopePaths: string[] = [];
	workingDir = '';  // vault-relative path, '' means vault root
	triageAgentForSession: string | null = null;

	isStreaming = false;
	configDirty = true;
	streamingContent = '';
	renderScheduled = false;
	showDebugInfo = false;
	lastFullRenderLen = 0;
	fullRenderTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Turn-level metadata ────────────────────────────────────
	turnStartTime = 0;
	turnToolsUsed: string[] = [];
	turnSkillsUsed: string[] = [];
	turnUsage: {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; model?: string} | null = null;
	activeToolCalls = new Map<string, {toolName: string; detailsEl: HTMLDetailsElement}>();
	activeSubagentBlocks = new Map<string, HTMLElement>();

	// ── Session sidebar state ──────────────────────────────────
	activeSessions = new Map<string, BackgroundSession>();
	sessionList: import('./copilot').SessionMetadata[] = [];
	sessionNames: Record<string, string> = {};
	currentSessionId: string | null = null;
	sidebarWidth = 40;
	sessionFilter = '';
	sessionTypeFilter = new Set<'chat' | 'inline' | 'trigger' | 'search' | 'other'>(['chat', 'trigger']);
	sessionSort: 'modified' | 'created' | 'name' = 'modified';

	// ── Tab state ────────────────────────────────────────────────
	activeTab: 'chat' | 'triggers' | 'search' | 'tools' = 'chat';

	// ── Triggers panel state ─────────────────────────────────────
	triggerHistoryFilter = '';
	triggerHistoryAgentFilter = '';
	triggerHistorySort: 'date' | 'name' = 'date';
	triggerConfigSort: 'name' | 'modified' = 'name';

	// ── Search panel state ───────────────────────────────────────
	searchAgent = '';
	searchModel = '';
	searchWorkingDir = '';
	searchEnabledSkills: Set<string> = new Set();
	searchEnabledMcpServers: Set<string> = new Set();
	searchAgentSelect!: HTMLSelectElement;
	searchModelSelect!: HTMLSelectElement;
	searchSkillsBtnEl!: HTMLButtonElement;
	searchToolsBtnEl!: HTMLButtonElement;
	searchCwdBtnEl!: HTMLButtonElement;
	searchInputEl!: HTMLTextAreaElement;
	searchBtnEl!: HTMLButtonElement;
	searchResultsEl!: HTMLElement;
	searchSession: CopilotSession | null = null;
	isSearching = false;
	searchModeToggleEl!: HTMLButtonElement;
	searchAdvancedToolbarEl!: HTMLElement;
	basicSearchSession: CopilotSession | null = null;

	// ── Search result cache ────────────────────────────────────
	searchCache = new Map<string, {content: string; cachedAt: number; scopePaths: string[]; mode: 'basic' | 'advanced'; agent?: string}>();
	static readonly SEARCH_CACHE_TTL = 5 * 60 * 1000;
	static readonly SEARCH_CACHE_MAX = 50;

	// ── DOM refs ─────────────────────────────────────────────────
	mainEl!: HTMLElement;
	tabBarEl!: HTMLElement;
	chatPanelEl!: HTMLElement;
	triggersPanelEl!: HTMLElement;
	searchPanelEl!: HTMLElement;
	toolsPanelEl!: HTMLElement;
	toolsMcpListEl!: HTMLElement;
	toolsAgentListEl!: HTMLElement;
	triggerHistoryListEl!: HTMLElement;
	triggerConfigListEl!: HTMLElement;
	chatContainer!: HTMLElement;
	streamingBodyEl: HTMLElement | null = null;
	toolCallsContainer: HTMLElement | null = null;
	inputEl!: HTMLTextAreaElement;
	attachmentsBar!: HTMLElement;
	activeNoteBar!: HTMLElement;
	triggerTestBar!: HTMLElement;
	agentEditBar!: HTMLElement;
	scopeBar!: HTMLElement;
	sendBtn!: HTMLButtonElement;
	agentSelect!: HTMLSelectElement;
	modelSelect!: HTMLSelectElement;
	modelIconEl!: HTMLSpanElement;
	skillsBtnEl!: HTMLButtonElement;
	toolsBtnEl!: HTMLButtonElement;
	cwdBtnEl!: HTMLButtonElement;
	debugBtnEl!: HTMLElement;
	streamingComponent: Component | null = null;
	streamingWrapperEl: HTMLElement | null = null;

	// ── Config file watcher ──────────────────────────────────────
	configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	configLoading = false;
	configLoadedAt = 0;

	// ── Prompt dropdown DOM refs ─────────────────────────────────
	promptDropdown: HTMLElement | null = null;
	promptDropdownIndex = -1;

	// ── Agent mention dropdown DOM refs ─────────────────────────
	agentDropdown: HTMLElement | null = null;
	agentDropdownIndex = -1;
	/** Position in the input where the `@` mention starts. */
	agentMentionStart = -1;

	// ── Built-in slash commands ─────────────────────────────────
	static readonly BUILTIN_COMMANDS: {name: string; description: string}[] = [
		{name: 'clear', description: 'Clear conversation and start fresh'},
		{name: 'new', description: 'Start a new conversation (keeps history in sidebar)'},
		{name: 'help', description: 'Show available commands, agents, and prompts'},
		{name: 'agents', description: 'List available agents'},
		{name: 'models', description: 'List available models'},
		{name: 'model', description: 'Switch model (e.g. /model gpt-4o)'},
		{name: 'agent', description: 'Switch agent (e.g. /agent coder)'},
		{name: 'trigger-debug', description: 'Show trigger diagnostic info'},
		{name: 'tasks', description: 'Show active and recent tasks'},
		{name: 'reference', description: 'Show frontmatter property reference for agents, prompts, triggers, and skills'},
	];

	// ── Session sidebar DOM refs ─────────────────────────────────
	sidebarEl!: HTMLElement;
	sidebarListEl!: HTMLElement;
	sidebarSearchEl!: HTMLInputElement;
	sidebarFilterEl!: HTMLButtonElement;
	sidebarSortEl!: HTMLButtonElement;
	sidebarRefreshEl!: HTMLButtonElement;
	sidebarDeleteEl!: HTMLButtonElement;
	splitterEl!: HTMLElement;

	eventUnsubscribers: (() => void)[] = [];

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
		this.addAction('plus', 'New conversation', () => void this.newConversation());

		this.buildUI();

		// Load persisted state before rendering lists
		this.sessionNames = this.plugin.settings.sessionNames ?? {};

		await this.loadAllConfigs();
		void this.loadSessions();

		// Initialize trigger scheduler
		this.initTriggerScheduler();

		// Initialize vault index
		this.vaultIndex = new VaultIndex(this.app);

		// Initialize context builder
		this.contextBuilder = new ContextBuilder(this.app, this.vaultIndex);

		// Watch sidekick folder for config changes and auto-refresh
		this.registerConfigFileWatcher();

		// Track active note and editor selection
		this.updateActiveNote();
		this.registerEvent(
			this.app.workspace.on('file-open', () => this.updateActiveNote())
		);
		this.startSelectionPolling();
	}

	async onClose(): Promise<void> {
		if (this.selectionPollTimer) { clearInterval(this.selectionPollTimer); this.selectionPollTimer = null; }
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		this.closePromptDropdown();
		this.closeAgentDropdown();
		this.triggerScheduler?.stop();
		if (this.basicSearchSession) {
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
		}
		await this.disconnectAllSessions();
	}

	// ── UI construction ──────────────────────────────────────────

	buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass('sidekick-root');

		// Main area (tab bar + panels)
		this.mainEl = root.createDiv({cls: 'sidekick-main'});

		// Tab bar
		this.buildTabBar(this.mainEl);

		// ── Chat panel ───────────────────────────────────────
		this.chatPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-chat'});

		// Chat content wrapper (chat + bottom)
		const chatContent = this.chatPanelEl.createDiv({cls: 'sidekick-chat-content'});

		// Chat history (scrollable)
		this.chatContainer = chatContent.createDiv({cls: 'sidekick-chat sidekick-hide-debug'});
		this.renderWelcome();

		// Bottom panel
		const bottom = chatContent.createDiv({cls: 'sidekick-bottom'});

		// Input area
		this.buildInputArea(bottom);

		// Config toolbar (agents, models, skills, tools, action buttons)
		this.buildConfigToolbar(bottom);

		// Splitter + session sidebar inside chat panel
		this.splitterEl = this.chatPanelEl.createDiv({cls: 'sidekick-splitter'});
		this.initSplitter();
		this.buildSessionSidebar(this.chatPanelEl);

		// ── Triggers panel ────────────────────────────────────
		this.triggersPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-triggers is-hidden'});
		this.buildTriggersPanel(this.triggersPanelEl);

		// ── Search panel ─────────────────────────────────────
		this.searchPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-search is-hidden'});
		this.buildSearchPanel(this.searchPanelEl);

		// ── Tools panel ──────────────────────────────────────
		this.toolsPanelEl = this.mainEl.createDiv({cls: 'sidekick-tab-panel sidekick-tab-panel-tools is-hidden'});
		this.buildToolsPanel(this.toolsPanelEl);
	}

	buildTabBar(parent: HTMLElement): void {
		this.tabBarEl = parent.createDiv({cls: 'sidekick-tab-bar'});
		const tabs: {id: 'chat' | 'triggers' | 'search' | 'tools'; icon: string; label: string}[] = [
			{id: 'chat', icon: 'message-square', label: 'Chat'},
			{id: 'triggers', icon: 'zap', label: 'Triggers'},
			{id: 'search', icon: 'search', label: 'Search'},
			{id: 'tools', icon: 'plug', label: 'Tools'},
		];
		for (const tab of tabs) {
			const btn = this.tabBarEl.createDiv({cls: 'sidekick-tab' + (tab.id === this.activeTab ? ' is-active' : '')});
			btn.dataset.tab = tab.id;
			const iconEl = btn.createSpan({cls: 'sidekick-tab-icon'});
			setIcon(iconEl, tab.icon);
			btn.createSpan({cls: 'sidekick-tab-label', text: tab.label});
			btn.addEventListener('click', () => this.switchTab(tab.id));
		}
	}

	switchTab(tab: 'chat' | 'triggers' | 'search' | 'tools'): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;

		// Update tab bar active state
		this.tabBarEl.querySelectorAll('.sidekick-tab').forEach(el => {
			el.toggleClass('is-active', (el as HTMLElement).dataset.tab === tab);
		});

		// Show/hide panels
		this.chatPanelEl.toggleClass('is-hidden', tab !== 'chat');
		this.triggersPanelEl.toggleClass('is-hidden', tab !== 'triggers');
		this.searchPanelEl.toggleClass('is-hidden', tab !== 'search');
		this.toolsPanelEl.toggleClass('is-hidden', tab !== 'tools');

		// Refresh tools panel content when switching to it
		if (tab === 'tools') {
			this.renderToolsPanel();
		}
	}

	renderWelcome(): void {
		const welcome = this.chatContainer.createDiv({cls: 'sidekick-welcome'});
		const icon = welcome.createDiv({cls: 'sidekick-welcome-icon'});
		setIcon(icon, 'brain');
		welcome.createEl('h3', {text: 'Sidekick'});
		welcome.createEl('p', {
			text: 'Your AI-powered second brain. Select an agent, choose a model, configure tools and get the job done!',
			cls: 'sidekick-welcome-desc',
		});
	}

	buildInputArea(parent: HTMLElement): void {
		const inputArea = parent.createDiv({cls: 'sidekick-input-area'});

		// Attach buttons row above textarea
		const inputActions = inputArea.createDiv({cls: 'sidekick-input-actions'});

		const scopeBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Select vault scope'}});
		setIcon(scopeBtn, 'folder');
		scopeBtn.addEventListener('click', () => this.openScopeModal());

		const attachBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Attach file'}});
		setIcon(attachBtn, 'paperclip');
		attachBtn.addEventListener('click', () => this.handleAttachFile());

		const clipBtn = inputActions.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Paste clipboard'}});
		setIcon(clipBtn, 'clipboard-paste');
		clipBtn.addEventListener('click', () => void this.handleClipboard());

		// Attachments, active note & scope (shown inline after action buttons)
		this.attachmentsBar = inputActions.createDiv({cls: 'sidekick-attachments-bar'});
		this.activeNoteBar = inputActions.createDiv({cls: 'sidekick-active-note-bar'});
		this.triggerTestBar = inputActions.createDiv({cls: 'sidekick-trigger-test-bar is-hidden'});
		this.agentEditBar = inputActions.createDiv({cls: 'sidekick-agent-edit-bar is-hidden'});
		this.scopeBar = inputActions.createDiv({cls: 'sidekick-scope-bar'});

		// Row for textarea + send button
		const inputRow = inputArea.createDiv({cls: 'sidekick-input-row'});

		this.inputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-input',
			attr: {placeholder: 'Ask something… Use / for commands, @ for agents', rows: '1'},
		});

		// Auto-resize
		this.inputEl.addEventListener('input', () => {
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
			this.handlePromptTrigger();
			this.handleAgentMentionTrigger();
		});

		// Ctrl+Enter or Enter (without Shift) to send
		// Register on window in capture phase — earliest interception before Obsidian's hotkey system
		const keyHandler = (e: KeyboardEvent) => {
			if (document.activeElement !== this.inputEl) return;

			// Handle prompt dropdown navigation
			if (this.promptDropdown) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					this.navigatePromptDropdown(1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					this.navigatePromptDropdown(-1);
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					this.selectPromptFromDropdown();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.closePromptDropdown();
					return;
				}
			}

			// Handle agent mention dropdown navigation
			if (this.agentDropdown) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					this.navigateAgentDropdown(1);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					this.navigateAgentDropdown(-1);
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					this.selectAgentFromDropdown();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.closeAgentDropdown();
					return;
				}
			}

			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				void this.handleSend();
				return;
			}

			const isAttachShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a';
			if (isAttachShortcut) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				this.toggleCurrentSuggestion();
			}
		};
		window.addEventListener('keydown', keyHandler, true);
		this.register(() => window.removeEventListener('keydown', keyHandler, true));

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

		// Drag-and-drop external files onto the input area
		let dragCounter = 0;
		inputArea.addEventListener('dragenter', (e: DragEvent) => {
			e.preventDefault();
			dragCounter++;
			inputArea.addClass('sidekick-drag-over');
		});
		inputArea.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		});
		inputArea.addEventListener('dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) {
				dragCounter = 0;
				inputArea.removeClass('sidekick-drag-over');
			}
		});
		inputArea.addEventListener('drop', (e: DragEvent) => {
			e.preventDefault();
			dragCounter = 0;
			inputArea.removeClass('sidekick-drag-over');
			this.handleFileDrop(e);
		});

		// Edit button (opens Edit modal with chat input text)
		const editBtn = inputRow.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Edit text'}});
		setIcon(editBtn, 'pencil-line');
		editBtn.addEventListener('click', () => this.openEditFromChat());

		// Send / Stop button
		this.sendBtn = inputRow.createEl('button', {
			cls: 'clickable-icon sidekick-send-btn',
			attr: {title: 'Send message'},
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

	buildConfigToolbar(parent: HTMLElement): void {
		const toolbar = parent.createDiv({cls: 'sidekick-toolbar'});

		// New conversation button
		const newChatBtn = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'New conversation'}});
		setIcon(newChatBtn, 'plus');
		newChatBtn.addEventListener('click', () => void this.newConversation());

		// Agent dropdown
		const agentGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.agentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.agentSelect.addEventListener('change', () => {
			this.selectAgent(this.agentSelect.value);
		});

		// Model dropdown
		const modelGroup = toolbar.createDiv({cls: 'sidekick-toolbar-group'});
		this.modelIconEl = modelGroup.createSpan({cls: 'sidekick-toolbar-icon clickable-icon'});
		setIcon(this.modelIconEl, 'cpu');
		this.modelIconEl.addEventListener('click', (e) => { e.stopPropagation(); this.openReasoningMenu(e); });
		this.modelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.modelSelect.addEventListener('change', () => {
			this.selectedModel = this.modelSelect.value;
			this.configDirty = true;
			this.updateReasoningBadge();
		});
		this.modelSelect.addEventListener('mousedown', () => {
			if (this.models.length === 0) void this.refreshModels();
		});

		// Skills button
		this.skillsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.skillsBtnEl, 'wand-2');
		this.skillsBtnEl.addEventListener('click', (e) => this.openSkillsMenu(e));

		// Tools button
		this.toolsBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.toolsBtnEl, 'plug');
		this.toolsBtnEl.addEventListener('click', (e) => this.openToolsMenu(e));

		// Working directory button
		this.cwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Working directory'}});
		setIcon(this.cwdBtnEl, 'hard-drive-download');
		this.cwdBtnEl.addEventListener('click', () => this.openCwdPicker());
		this.updateCwdButton();

		// Spacer to push debug toggle to the right
		toolbar.createDiv({cls: 'sidekick-toolbar-spacer'});

		// Debug toggle
		this.debugBtnEl = toolbar.createDiv({cls: 'sidekick-debug-toggle', attr: {title: 'Show tool & token details'}});
		const debugIcon = this.debugBtnEl.createSpan({cls: 'sidekick-debug-icon'});
		setIcon(debugIcon, 'bug');
		const debugCheck = this.debugBtnEl.createEl('input', {type: 'checkbox', cls: 'sidekick-debug-checkbox'});
		debugCheck.checked = this.showDebugInfo;
		debugCheck.addEventListener('change', () => {
			this.showDebugInfo = debugCheck.checked;
			setDebugEnabled(this.showDebugInfo);
			this.chatContainer.toggleClass('sidekick-hide-debug', !this.showDebugInfo);
		});
		this.debugBtnEl.addEventListener('click', (e) => {
			if (e.target !== debugCheck) {
				debugCheck.checked = !debugCheck.checked;
				debugCheck.dispatchEvent(new Event('change'));
			}
		});
	}

	// ── Config loading ───────────────────────────────────────────

	async loadAllConfigs(options?: {silent?: boolean}): Promise<void> {
		if (this.configLoading) return;
		this.configLoading = true;
		try {
			// Build input resolver that reads stored values or prompts for missing ones
			const inputResolver: InputResolver = async (input: McpInputVariable) => {
				const isPassword = input.password === true;
				let value = getMcpInputValue(this.app, this.plugin, input.id, isPassword);
				if (value === undefined) {
					// Prompt user for the missing value
					value = await new Promise<string | undefined>(resolve => {
						const modal = new McpInputPromptModal(this.app, input, (v) => {
							if (v !== undefined) {
								void setMcpInputValue(this.app, this.plugin, input.id, v, isPassword);
							}
							resolve(v);
						});
						modal.open();
					});
				}
				return value;
			};

			// Parallel-load all config files (independent I/O)
			const [agents, skills, mcpServers, prompts, triggers, globalInstructions] = await Promise.all([
				loadAgents(this.app, getAgentsFolder(this.plugin.settings)),
				loadSkills(this.app, getSkillsFolder(this.plugin.settings)),
				loadMcpServers(this.app, getToolsFolder(this.plugin.settings), inputResolver),
				loadPrompts(this.app, getPromptsFolder(this.plugin.settings)),
				loadTriggers(this.app, getTriggersFolder(this.plugin.settings)),
				loadInstructions(this.app, this.plugin.settings.sidekickFolder),
			]);
			this.agents = agents;
			this.skills = skills;
			this.mcpServers = mcpServers;
			this.mcpServerStatus.clear();
			this.prompts = prompts;
			this.triggers = triggers;
			this.globalInstructions = globalInstructions;
			this.triggerScheduler?.setTriggers(this.triggers);
			this.renderTriggerConfigList();
			this.renderTriggerHistory();
			this.renderTriggerTestBar();
			this.renderAgentEditBar();

			// Enable all skills and tools by default (agent filter applied in updateConfigUI)
			this.enabledSkills = new Set(this.skills.map(s => s.name));
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));

			// Populate model list: BYOK direct providers don't need a copilot connection
			if (!options?.silent) {
				const preset = this.plugin.settings.providerPreset;
				const isByok = preset !== 'github';
				if (isByok && this.plugin.settings.providerModel) {
					const id = this.plugin.settings.providerModel;
					this.models = [{id, name: id} as ModelInfo];
				} else if (isByok) {
					// BYOK providers without a model name: keep existing list
				} else if (this.plugin.copilot) {
					try {
						this.models = await this.plugin.copilot.listModels();
					} catch (err) {
						console.warn('Sidekick: failed to load models', err);
					}
				}
			}
		} catch (e) {
			console.error('Sidekick: failed to load configs', e);
		} finally {
			this.configLoading = false;
			this.configLoadedAt = Date.now();
		}

		this.updateConfigUI();
		this.configDirty = true;
		if (!options?.silent) {
			new Notice(`Loaded ${this.agents.length} agent(s), ${this.models.length} model(s), ${this.skills.length} skill(s), ${this.mcpServers.length} tool server(s), ${this.prompts.length} prompt(s), ${this.triggers.length} trigger(s).`);
		}
	}

	registerConfigFileWatcher(): void {
		const DEBOUNCE_MS = 500;

		const scheduleRefresh = (filePath: string) => {
			const base = normalizePath(this.plugin.settings.sidekickFolder);
			if (!filePath.startsWith(base + '/')) return;
			if (this.configLoading || (Date.now() - this.configLoadedAt < 2_000)) return;
			debugTrace(`Sidekick: config file changed: ${filePath}`);
			if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
			this.configRefreshTimer = setTimeout(() => {
				this.configRefreshTimer = null;
				void this.loadAllConfigs({silent: true});
			}, DEBOUNCE_MS);
		};

		this.registerEvent(
			this.app.vault.on('modify', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => scheduleRefresh(file.path))
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				scheduleRefresh(file.path);
				scheduleRefresh(oldPath);
			})
		);
	}

	updateConfigUI(): void {
		// Agents
		this.agentSelect.empty();
		const noAgent = this.agentSelect.createEl('option', {text: 'Auto', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.agentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}
		if (this.selectedAgent && this.agents.some(a => a.name === this.selectedAgent)) {
			this.agentSelect.value = this.selectedAgent;
			const selAgent = this.agents.find(a => a.name === this.selectedAgent);
			this.agentSelect.title = selAgent ? selAgent.instructions : '';
		} else {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.title = '';
		}

		// Auto-select agent's preferred model
		const selectedAgentConfig = this.agents.find(a => a.name === this.selectedAgent);
		const resolvedModel = this.resolveModelForAgent(selectedAgentConfig, this.selectedModel || undefined);
		if (resolvedModel) {
			this.selectedModel = resolvedModel;
		}

		// Models
		this.populateModelSelect();
		if (this.selectedModel && this.models.some(m => m.id === this.selectedModel)) {
			this.modelSelect.value = this.selectedModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
		}

		// Apply agent's tools and skills filter
		const selectedAgentForFilter = this.agents.find(a => a.name === this.selectedAgent);
		this.applyAgentToolsAndSkills(selectedAgentForFilter);
		this.updateReasoningBadge();

		// Update search panel dropdowns
		if (this.searchAgentSelect) {
			this.updateSearchConfigUI();
		}

		// Update tools panel if visible
		if (this.activeTab === 'tools') {
			this.renderToolsPanel();
		}
	}

	populateModelSelect(): void {
		this.modelSelect.empty();
		if (this.models.length === 0) {
			const placeholder = this.modelSelect.createEl('option', {text: 'No models — click to retry'});
			placeholder.value = '';
			placeholder.disabled = true;
		}
		for (const model of this.models) {
			const opt = this.modelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
	}

	async refreshModels(): Promise<void> {
		const preset = this.plugin.settings.providerPreset;
		const isByok = preset !== 'github';
		if (isByok && this.plugin.settings.providerModel) {
			const id = this.plugin.settings.providerModel;
			this.models = [{id, name: id} as ModelInfo];
		} else if (isByok) {
			return;
		} else if (this.plugin.copilot) {
			try {
				this.models = await this.plugin.copilot.listModels();
			} catch (err) {
				console.warn('Sidekick: failed to refresh models', err);
			}
		}
		this.populateModelSelect();
		if (this.models.length > 0 && this.models[0]) {
			this.selectedModel = this.models[0].id;
			this.modelSelect.value = this.selectedModel;
			this.configDirty = true;
			this.updateReasoningBadge();
		}
	}

	getSelectedModelInfo(): ModelInfo | undefined {
		return this.models.find(m => m.id === this.selectedModel);
	}

	openReasoningMenu(e: MouseEvent): void {
		if (this.currentSession && !this.configDirty) return;
		const model = this.getSelectedModelInfo();
		const supported = model?.supportedReasoningEfforts;
		if (!model?.capabilities?.supports?.reasoningEffort || !supported || supported.length === 0) {
			const menu = new Menu();
			menu.addItem(item => item.setTitle('Model does not support reasoning effort').setDisabled(true));
			menu.showAtMouseEvent(e);
			return;
		}
		const menu = new Menu();
		const current = this.plugin.settings.reasoningEffort;
		for (const level of supported) {
			const label = level.charAt(0).toUpperCase() + level.slice(1);
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(level === current)
					.onClick(() => {
						// Toggle off if already selected
						this.plugin.settings.reasoningEffort = level === current ? '' : level;
						void this.plugin.saveSettings();
						this.configDirty = true;
						this.updateReasoningBadge();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	updateReasoningBadge(): void {
		const model = this.getSelectedModelInfo();
		const supportsReasoning = model?.capabilities?.supports?.reasoningEffort && (model.supportedReasoningEfforts?.length ?? 0) > 0;
		const level = this.plugin.settings.reasoningEffort;
		// Reset if current level isn't supported by the new model
		if (level !== '' && supportsReasoning && model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.includes(level as ReasoningEffort)) {
			this.plugin.settings.reasoningEffort = '';
			void this.plugin.saveSettings();
		}
		const current = this.plugin.settings.reasoningEffort;
		const active = current !== '' && !!supportsReasoning;
		this.modelIconEl.toggleClass('is-active', active);
		this.modelIconEl.toggleClass('is-non-interactive', !supportsReasoning);
		if (!supportsReasoning) {
			this.modelIconEl.setAttribute('title', 'Model does not support reasoning effort');
		} else {
			const label = current === '' ? 'Reasoning effort' : `Reasoning effort: ${current.charAt(0).toUpperCase() + current.slice(1)}`;
			this.modelIconEl.setAttribute('title', label);
		}
	}

	openSkillsMenu(e: MouseEvent): void {
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

	openToolsMenu(e: MouseEvent): void {
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
		menu.addSeparator();
		const currentApproval = this.plugin.settings.toolApproval;
		menu.addItem(item => {
			item.setTitle('Approval mode');
			const sub: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
			sub.addItem(si => {
				si.setTitle('Allow (auto-approve)')
					.setChecked(currentApproval === 'allow')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'allow';
						await this.plugin.saveSettings();
					});
			});
			sub.addItem(si => {
				si.setTitle('Ask (require approval)')
					.setChecked(currentApproval === 'ask')
					.onClick(async () => {
						this.plugin.settings.toolApproval = 'ask';
						await this.plugin.saveSettings();
					});
			});
		});
		menu.showAtMouseEvent(e);
	}

	/**
	 * Apply the agent's tools and skills filter.
	 * If the agent specifies a list, enable only those.
	 * If the list is empty/undefined or the agent has no preference, enable all.
	 */
	/**
	 * Switch to the named agent: update state, dropdown, model, tools/skills, and mark config dirty.
	 * No-op if the agent name is not found.
	 */
	selectAgent(agentName: string): void {
		// Handle deselecting (empty = "Auto" / no agent)
		if (!agentName) {
			this.selectedAgent = '';
			this.agentSelect.value = '';
			this.agentSelect.selectedIndex = 0;
			this.agentSelect.title = '';
			this.applyAgentToolsAndSkills(undefined);
			this.configDirty = true;
			return;
		}
		const agent = this.agents.find(a => a.name === agentName)
			// Fallback: case-insensitive match
			?? this.agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
		if (!agent) return; // No matching agent found — leave dropdown unchanged
		this.selectedAgent = agent.name;
		// Update the dropdown — set both .value and .selectedIndex for reliability
		this.agentSelect.value = agent.name;
		const opts = this.agentSelect.options;
		for (let i = 0; i < opts.length; i++) {
			if (opts[i]!.value === agent.name) {
				this.agentSelect.selectedIndex = i;
				break;
			}
		}
		this.agentSelect.title = agent.instructions;
		// Auto-select agent's preferred model
		const resolvedModel = this.resolveModelForAgent(agent, this.selectedModel || undefined);
		if (resolvedModel && resolvedModel !== this.selectedModel) {
			this.selectedModel = resolvedModel;
			this.modelSelect.value = resolvedModel;
		}
		this.applyAgentToolsAndSkills(agent);
		this.configDirty = true;
	}

	applyAgentToolsAndSkills(agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed.
		// Agent names in the tools list are sub-agent references, not MCP servers.
		if (agent?.tools !== undefined) {
			const agentNames = new Set(this.agents.map(a => a.name));
			const mcpOnly = agent.tools.filter(t => !agentNames.has(t));
			const allowed = new Set(mcpOnly);
			this.enabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.enabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.enabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSkillsBadge();
		this.updateToolsBadge();
	}

	updateSkillsBadge(): void {
		const count = this.enabledSkills.size;
		this.skillsBtnEl.toggleClass('is-active', count > 0);
		this.skillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	updateToolsBadge(): void {
		const count = this.enabledMcpServers.size;
		this.toolsBtnEl.toggleClass('is-active', count > 0);
		this.toolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	// ── Attachments & scope ──────────────────────────────────────

	renderAttachments(): void {
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
			const typeIcon = att.type === 'image' ? 'image' : att.type === 'clipboard' ? 'clipboard' : att.type === 'selection' ? 'text-cursor-input' : 'file-text';
			const ic = tag.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, typeIcon);
			tag.createSpan({text: att.name, cls: 'sidekick-attachment-name'});
			const removeBtn = tag.createSpan({cls: 'sidekick-attachment-remove'});
			setIcon(removeBtn, 'x');
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
				this.rebuildSuggestions(false);
				this.renderActiveNoteBar();
			});
		}
	}

	/** Set the vault scope programmatically and refresh the scope bar. */
	public setScope(paths: string[]): void {
		this.scopePaths = paths;
		this.renderScopeBar();
	}

	/** Open the search tab with scope set to the given folder. */
	public openSearchWithScope(folderPath: string): void {
		this.searchWorkingDir = folderPath;
		this.updateSearchCwdButton();
		this.switchTab('search');
		this.searchInputEl.focus();
	}

	/** Set the working directory programmatically. */
	public setWorkingDir(folderPath: string): void {
		this.workingDir = folderPath;
		this.updateCwdButton();
		this.configDirty = true;
	}

	/** Set the prompt text programmatically and focus the input. */
	public setPromptText(text: string): void {
		this.inputEl.value = text;
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	}

	/** Add a selection attachment from the editor context menu / brain button. */
	public addSelectionAttachment(text: string, info: SelectionInfo): void {
		// Resolve filePath: prefer info.filePath, fall back to current active file
		const filePath = info.filePath ?? this.app.workspace.getActiveFile()?.path;
		if (!filePath) return; // can't create selection attachment without a file
		const displayName = info.startLine === info.endLine
			? `${info.fileName}:${info.startLine}`
			: `${info.fileName}:${info.startLine}-${info.endLine}`;
		this.attachments.push({
			type: 'selection',
			name: displayName,
			path: filePath,
			content: text,
			selection: {
				startLine: info.startLine,
				startChar: info.startChar,
				endLine: info.endLine,
				endChar: info.endChar,
			},
		});
		this.renderAttachments();
		this.renderActiveNoteBar();
	}

	renderScopeBar(): void {
		this.scopeBar.empty();
		if (this.scopePaths.length === 0) {
			this.scopeBar.addClass('is-hidden');
			return;
		}
		this.scopeBar.removeClass('is-hidden');

		const label = this.scopeBar.createSpan({cls: 'sidekick-scope-label'});
		setIcon(label, 'folder-tree');
		const isEntireVault = this.scopePaths.length === 1 && this.scopePaths[0] === '/';
		const scopeText = isEntireVault
			? ' Entire vault scope'
			: ` ${this.scopePaths.length} item(s) in scope`;
		label.appendText(scopeText);

		const tooltipItems = this.scopePaths.map(p => p === '/' ? this.app.vault.getName() : p).join('\n');
		label.setAttribute('title', tooltipItems);
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

	updateActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		this.activeNotePath = file ? file.path : null;
		// Clear selection when switching files — pollSelection will pick up the new one
		this.activeSelection = null;
		this.rebuildSuggestions(true);
		this.renderActiveNoteBar();
		this.renderTriggerTestBar();
		this.renderAgentEditBar();

		// Update working directory to the parent folder of the active note
		if (file) {
			const lastSlash = file.path.lastIndexOf('/');
			const newDir = lastSlash > 0 ? file.path.substring(0, lastSlash) : '';
			if (newDir !== this.workingDir) {
				this.workingDir = newDir;
				this.updateCwdButton();
				this.configDirty = true;
			}
		}
	}

	/**
	 * Poll the active editor for selection changes and update the active note bar.
	 * Uses a lightweight interval instead of a CM6 extension to avoid coupling.
	 */
	startSelectionPolling(): void {
		const POLL_MS = 300;
		const timerId = window.setInterval(() => this.pollSelection(), POLL_MS);
		this.selectionPollTimer = timerId as unknown as ReturnType<typeof setInterval>;
		this.registerInterval(timerId);
	}

	pollSelection(): void {
		// Try to get the active MarkdownView. If focus is in our chat view,
		// fall back to iterating workspace leaves to find the most recent editor.
		let mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		let editorIsActive = !!mdView;

		if (!mdView && this.containerEl.contains(document.activeElement)) {
			// Focus is in our chat — find the last MarkdownView leaf to read cursor from
			this.editorHadFocus = false;
			this.app.workspace.iterateAllLeaves(leaf => {
				if (!mdView && leaf.view instanceof MarkdownView) {
					mdView = leaf.view;
				}
			});
			editorIsActive = false;
		}

		if (!mdView) {
			this.editorHadFocus = false;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.rebuildSuggestions(true);
				this.renderActiveNoteBar();
			}
			this.cursorPosition = null;
			return;
		}

		const editorFocused = editorIsActive && mdView.containerEl.contains(document.activeElement);
		const editor = mdView.editor;
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const hasSelection = from.line !== to.line || from.ch !== to.ch;

		// Always update cursor position from the editor
		const cursorFile = mdView.file;
		if (cursorFile) {
			this.cursorPosition = {
				filePath: cursorFile.path,
				fileName: cursorFile.name,
				line: from.line + 1,
				ch: from.ch,
			};
		}

		if (!hasSelection) {
			// Editor just regained focus (wasn't focused last tick) — the selection
			// collapsed because of the focus change, not a deliberate user action.
			// Keep the tracked selection intact.
			if (editorFocused && !this.editorHadFocus) {
				this.editorHadFocus = true;
				return;
			}
			// Editor was already focused — user deliberately deselected.
			// Or editor is not focused (cursor read from background leaf) — keep selection if tracked.
			if (!editorIsActive) {
				// Reading from background editor — don't clear selection
				return;
			}
			this.editorHadFocus = editorFocused;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.rebuildSuggestions(true);
				this.renderActiveNoteBar();
			}
			return;
		}
		// Active selection present — cursor position is the selection start (already set above)
		this.editorHadFocus = editorFocused;

		const file = mdView.file;
		if (!file) return;

		const text = editor.getRange(from, to);
		const prev = this.activeSelection;
		// Only re-render if the selection actually changed
		if (prev && prev.filePath === file.path && prev.startLine === from.line + 1 && prev.endLine === to.line + 1 && prev.startChar === from.ch && prev.endChar === to.ch) {
			return;
		}

		this.activeSelection = {
			filePath: file.path,
			fileName: file.name,
			text,
			startLine: from.line + 1,
			startChar: from.ch,
			endLine: to.line + 1,
			endChar: to.ch,
		};
		this.rebuildSuggestions(true);
		this.renderActiveNoteBar();
	}

	rebuildSuggestions(resetDismissed: boolean): void {
		const next: ContextSuggestion[] = [];

		if (this.activeSelection) {
			const sel = this.activeSelection;
			const name = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
			next.push({
				type: 'selection',
				path: sel.filePath,
				name,
				content: sel.text,
				selection: {
					startLine: sel.startLine,
					startChar: sel.startChar,
					endLine: sel.endLine,
					endChar: sel.endChar,
				},
				dismissed: false,
			});
		} else if (this.activeNotePath) {
			const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
			next.push({
				type: 'file',
				path: this.activeNotePath,
				name,
				dismissed: false,
			});
		}

		if (!resetDismissed) {
			for (const suggestion of next) {
				const existing = this.suggestions.find(s =>
					s.type === suggestion.type &&
					s.path === suggestion.path &&
					s.name === suggestion.name
				);
				if (existing?.dismissed) suggestion.dismissed = true;
			}
		}

		this.suggestions = next;
	}

	acceptSuggestion(index: number): void {
		const suggestion = this.suggestions[index];
		if (!suggestion) return;

		if (suggestion.type === 'selection') {
			const range = suggestion.selection;
			if (!range) return;
			this.attachments.push({
				type: 'selection',
				name: suggestion.name,
				path: suggestion.path,
				content: suggestion.content,
				selection: {...range},
			});
		} else {
			this.attachments.push({
				type: 'file',
				name: suggestion.name,
				path: suggestion.path,
			});
		}

		this.suggestions.splice(index, 1);
		this.renderAttachments();
		this.renderActiveNoteBar();
	}

	dismissSuggestion(index: number): void {
		const suggestion = this.suggestions[index];
		if (!suggestion) return;
		suggestion.dismissed = true;
		this.renderActiveNoteBar();
	}

	toggleCurrentSuggestion(): void {
		const idx = this.suggestions.findIndex(s => !s.dismissed);
		if (idx >= 0) {
			this.acceptSuggestion(idx);
			return;
		}

		if (this.activeSelection) {
			const sel = this.activeSelection;
			const attIdx = this.attachments.findIndex(a =>
				a.type === 'selection' &&
				a.path === sel.filePath &&
				a.selection?.startLine === sel.startLine &&
				a.selection?.endLine === sel.endLine &&
				a.selection?.startChar === sel.startChar &&
				a.selection?.endChar === sel.endChar
			);
			if (attIdx >= 0) {
				this.attachments.splice(attIdx, 1);
				this.renderAttachments();
				this.rebuildSuggestions(false);
				this.renderActiveNoteBar();
			}
			return;
		}

		if (this.activeNotePath) {
			const attIdx = this.attachments.findIndex(a =>
				a.type === 'file' && a.path === this.activeNotePath
			);
			if (attIdx >= 0) {
				this.attachments.splice(attIdx, 1);
				this.renderAttachments();
				this.rebuildSuggestions(false);
				this.renderActiveNoteBar();
			}
		}
	}

	renderActiveNoteBar(): void {
		this.activeNoteBar.empty();
		if (this.suggestions.length === 0) {
			this.activeNoteBar.addClass('is-hidden');
			return;
		}

		this.activeNoteBar.removeClass('is-hidden');
		this.activeNoteBar.createSpan({
			cls: 'sidekick-suggestions-label',
			text: 'Suggested context',
		});

		for (let i = 0; i < this.suggestions.length; i++) {
			const suggestion = this.suggestions[i];
			if (!suggestion || suggestion.dismissed) continue;

			if (this.attachments.some(a => a.type === suggestion.type && a.path === suggestion.path)) {
				continue;
			}

			const tag = this.activeNoteBar.createDiv({cls: 'sidekick-attachment-tag sidekick-active-note-tag sidekick-suggestion-tag'});
			const addBtn = tag.createSpan({cls: 'sidekick-suggestion-accept', attr: {title: 'Attach context'}});
			setIcon(addBtn, 'plus');
			addBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.acceptSuggestion(i);
			});

			const body = tag.createSpan({cls: 'sidekick-suggestion-body'});
			const ic = body.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, suggestion.type === 'selection' ? 'text-cursor-input' : 'file-text');
			body.createSpan({text: suggestion.name, cls: 'sidekick-attachment-name'});
			body.addEventListener('click', () => this.acceptSuggestion(i));

			const removeBtn = tag.createSpan({cls: 'sidekick-suggestion-dismiss', attr: {title: 'Dismiss suggestion'}});
			setIcon(removeBtn, 'x');
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.dismissSuggestion(i);
			});

			tag.setAttribute('title', suggestion.type === 'selection'
				? `Suggested selection from ${suggestion.path}`
				: `Suggested active note: ${suggestion.path}`);
		}

		if (this.activeNoteBar.children.length <= 1) {
			this.activeNoteBar.addClass('is-hidden');
		}
	}

	/** Placeholder for toolbar lock state updates (e.g. disabling config during streaming). */
	updateToolbarLock(): void {
		// No-op — reserved for future toolbar locking behavior.
	}

	/**
	 * Show a "Test trigger" button when the active file is a *.trigger.md inside the triggers folder.
	 */
	renderTriggerTestBar(): void {
		this.triggerTestBar.empty();
		const trigger = this.getActiveTrigger();
		if (!trigger) {
			this.triggerTestBar.addClass('is-hidden');
			return;
		}

		this.triggerTestBar.removeClass('is-hidden');
		const btn = this.triggerTestBar.createEl('button', {
			cls: 'sidekick-trigger-test-btn',
			attr: {title: `Test trigger: ${trigger.name}`},
		});
		const iconSpan = btn.createSpan({cls: 'sidekick-trigger-test-icon'});
		setIcon(iconSpan, 'play');
		btn.createSpan({text: `Test trigger: ${trigger.name}`});
		btn.addEventListener('click', () => {
			new Notice(`Testing trigger: ${trigger.name}`);
			// Send through the foreground chat so the user sees the response
			if (trigger.agent) {
				this.selectAgent(trigger.agent);
			}
			// Apply trigger-level model override if set
			if (trigger.model && this.models.some(m => m.id === trigger.model)) {
				this.selectedModel = trigger.model;
				this.modelSelect.value = trigger.model;
			}
			// Abort any active stream first, then send
			if (this.isStreaming && this.currentSession) {
				void this.currentSession.abort();
			}
			// Wait a tick for abort to settle, then send
			setTimeout(() => {
				this.inputEl.value = trigger.content;
				this.inputEl.dispatchEvent(new Event('input'));
				void this.handleSend();
			}, 100);
		});
	}

	/** Return the TriggerConfig for the active file, or null if it isn't a trigger file. */
	getActiveTrigger(): TriggerConfig | null {
		if (!this.activeNotePath) return null;
		const triggersFolder = getTriggersFolder(this.plugin.settings);
		if (!this.activeNotePath.startsWith(triggersFolder + '/')) return null;
		if (!this.activeNotePath.endsWith('.trigger.md')) return null;
		return this.triggers.find(t => t.filePath === this.activeNotePath) ?? null;
	}

	/**
	 * Show an "Edit agent" button when the active file is a *.agent.md inside the agents folder.
	 */
	renderAgentEditBar(): void {
		this.agentEditBar.empty();
		const agent = this.getActiveAgent();
		if (!agent) {
			this.agentEditBar.addClass('is-hidden');
			return;
		}

		this.agentEditBar.removeClass('is-hidden');
		const btn = this.agentEditBar.createEl('button', {
			cls: 'sidekick-agent-edit-bar-btn',
			attr: {title: `Edit agent: ${agent.name}`},
		});
		const iconSpan = btn.createSpan({cls: 'sidekick-agent-edit-bar-icon'});
		setIcon(iconSpan, 'pencil');
		btn.createSpan({text: `Edit agent: ${agent.name}`});
		btn.addEventListener('click', () => {
			this.openAgentEditor(agent);
		});
	}

	/** Return the AgentConfig for the active file, or null if it isn't an agent file. */
	getActiveAgent(): AgentConfig | null {
		if (!this.activeNotePath) return null;
		const agentsFolder = getAgentsFolder(this.plugin.settings);
		if (!this.activeNotePath.startsWith(agentsFolder + '/')) return null;
		if (!this.activeNotePath.endsWith('.agent.md')) return null;
		return this.agents.find(a => a.filePath === this.activeNotePath) ?? null;
	}

	handleAttachFile(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.classList.add('sidekick-file-input-hidden');
		document.body.appendChild(input);

		input.addEventListener('change', () => {
			if (!input.files) { input.remove(); return; }

			// Resolve absolute OS path: prefer Electron webUtils, fallback to File.path
			let getPath: (f: File) => string;
			try {
				const {webUtils} = globalThis.require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
				if (webUtils?.getPathForFile) {
					getPath = (f: File) => webUtils.getPathForFile(f);
				} else {
					getPath = (f: File) => (f as unknown as {path: string}).path || '';
				}
			} catch {
				getPath = (f: File) => (f as unknown as {path: string}).path || '';
			}

			for (let i = 0; i < input.files.length; i++) {
				const file = input.files[i];
				if (!file) continue;
				const filePath = getPath(file);
				if (!filePath) {
					continue;
				}
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			this.renderAttachments();
			input.remove();
		});

		input.addEventListener('cancel', () => input.remove());
		input.click();
	}

	async handleClipboard(): Promise<void> {
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

	async handleImagePaste(blob: File): Promise<void> {
		try {
			const buffer = await blob.arrayBuffer();
			const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
			const name = `paste-${Date.now()}.${ext}`;
			const folder = normalizePath(this.getImageAttachmentFolder());

			await this.ensureFolderExists(folder);

			const filePath = normalizePath(`${folder}/${name}`);
			await this.app.vault.createBinary(filePath, buffer);

			this.attachments.push({type: 'image', name, path: filePath});
			this.renderAttachments();
			new Notice('Image attached.');
		} catch (e) {
			new Notice(`Failed to attach image: ${String(e)}`);
		}
	}

	/** Handle files dropped onto the input area from the OS or vault tree. */
	handleFileDrop(e: DragEvent): void {
		const dt = e.dataTransfer;
		if (!dt) return;

		// ── Obsidian vault drag (file explorer) ──────────────────
		// Obsidian's file tree uses its internal dragManager rather than
		// standard HTML5 dataTransfer text.  The draggable object has
		// { type: 'file'|'folder'|'files', file?: TAbstractFile, files?: TAbstractFile[] }.
		const dragManager = (this.app as unknown as {dragManager?: {draggable?: {type: string; file?: unknown; files?: unknown[]}}}).dragManager;
		const draggable = dragManager?.draggable as {type: string; file?: TFile | TFolder; files?: (TFile | TFolder)[]} | undefined;

		if (draggable) {
			const items: (TFile | TFolder)[] = [];
			if ((draggable.type === 'file' || draggable.type === 'folder') && draggable.file) {
				items.push(draggable.file);
			} else if (draggable.type === 'files' && draggable.files) {
				items.push(...draggable.files);
			}

			if (items.length > 0) {
				for (const item of items) {
					if (item instanceof TFolder) {
						this.setScope([item.path]);
						this.setWorkingDir(item.path);
						new Notice(`Scope and working directory set to "${item.path}".`);
					} else if (item instanceof TFile) {
						this.attachments.push({type: 'file', name: item.name, path: item.path});
						this.renderAttachments();
						new Notice(`"${item.name}" attached.`);
					}
				}
				return;
			}
		}

		// ── Plain text drag (e.g. selected text from editor or browser) ──
		if (dt.files.length === 0) {
			const text = dt.getData('text/plain');
			if (text) {
				this.inputEl.value = text;
				this.inputEl.setCssProps({'--input-height': 'auto'});
				this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
				this.inputEl.focus();
				return;
			}
		}

		// ── External OS file drag ────────────────────────────────
		const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

		// Resolve absolute OS path using Electron webUtils, same as handleAttachFile
		let getPath: (f: File) => string;
		try {
			const {webUtils} = globalThis.require('electron') as {webUtils?: {getPathForFile: (f: File) => string}};
			if (webUtils?.getPathForFile) {
				getPath = (f: File) => webUtils.getPathForFile(f);
			} else {
				getPath = (f: File) => (f as unknown as {path: string}).path || '';
			}
		} catch {
			getPath = (f: File) => (f as unknown as {path: string}).path || '';
		}

		let attached = 0;
		for (let i = 0; i < dt.files.length; i++) {
			const file = dt.files[i];
			if (!file) continue;
			const filePath = getPath(file);
			if (!filePath) continue;

			const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
			if (IMAGE_EXTS.has(ext)) {
				// Save image to vault attachment folder, same as paste
				void this.handleImagePaste(file);
			} else {
				this.attachments.push({type: 'file', name: file.name, path: filePath, absolutePath: true});
			}
			attached++;
		}

		if (attached > 0) {
			this.renderAttachments();
			new Notice(`${attached} file${attached > 1 ? 's' : ''} attached.`);
		}
	}

	/** Recursively create a folder path if it doesn't already exist. */
	async ensureFolderExists(folderPath: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(folderPath)) return;
		const parts = folderPath.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	/**
	 * Resolve the folder where pasted images are saved.
	 * Uses the Obsidian "Attachment folder path" setting + a "sidekick" subfolder.
	 * Falls back to ".sidekick-attachments" at the vault root.
	 */
	getImageAttachmentFolder(): string {
		const configured = (this.app.vault as unknown as {getConfig: (key: string) => unknown}).getConfig('attachmentFolderPath') as string | undefined;
		if (configured && configured !== '/' && configured !== './' && configured !== '.') {
			// Obsidian attachment folder is set — use a "sidekick" subfolder inside it
			return `${configured}/sidekick`;
		}
		// No folder configured — use fallback at vault root
		return '.sidekick-attachments';
	}

	openScopeModal(): void {
		new VaultScopeModal(this.app, this.scopePaths, (paths) => {
			this.scopePaths = paths;
			this.renderScopeBar();
		}).open();
	}

	// ── Prompt slash-command dropdown ─────────────────────────────

	handlePromptTrigger(): void {
		const value = this.inputEl.value;
		// Trigger only when text starts with "/" (no space before the slash)
		if (!value.startsWith('/') || value.includes(' ')) {
			this.closePromptDropdown();
			// Clear tooltip if input no longer matches the active prompt
			if (this.activePrompt && !value.startsWith(`/${this.activePrompt.name}`)) {
				this.activePrompt = null;
				this.inputEl.removeAttribute('title');
			}
			return;
		}
		const query = value.slice(1).toLowerCase();

		// Merge built-in commands with user-defined prompts
		const builtinMatches = SidekickView.BUILTIN_COMMANDS
			.filter(c => c.name.toLowerCase().includes(query))
			.map(c => ({name: c.name, description: c.description, content: '', isBuiltin: true as const}));
		const promptMatches = this.prompts
			.filter(p => p.name.toLowerCase().includes(query))
			.map(p => ({...p, isBuiltin: false as const}));
		const combined = [...builtinMatches, ...promptMatches];

		if (combined.length === 0) {
			this.closePromptDropdown();
			return;
		}
		this.showPromptDropdown(combined);
	}

	showPromptDropdown(items: Array<{name: string; description?: string; content: string; agent?: string; isBuiltin: boolean}>): void {
		this.closePromptDropdown();
		this.promptDropdown = document.createElement('div');
		this.promptDropdown.addClass('sidekick-prompt-dropdown');
		this.promptDropdownIndex = 0;

		for (let i = 0; i < items.length; i++) {
			const p = items[i];
			if (!p) continue;
			const item = this.promptDropdown.createDiv({cls: 'sidekick-prompt-item' + (p.isBuiltin ? ' sidekick-prompt-builtin' : '')});
			if (i === 0) item.addClass('is-selected');
			item.setAttribute('title', p.isBuiltin ? p.description ?? '' : p.content);

			item.createSpan({cls: 'sidekick-prompt-item-name', text: `/${p.name}`});
			const descText = p.description || (p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content);
			item.createSpan({cls: 'sidekick-prompt-item-desc', text: descText});
			if (!p.isBuiltin && p.agent) {
				item.createSpan({cls: 'sidekick-prompt-item-agent', text: p.agent});
			}
			if (p.isBuiltin) {
				item.createSpan({cls: 'sidekick-prompt-item-badge', text: 'built-in'});
			}

			item.addEventListener('click', () => {
				this.promptDropdownIndex = i;
				this.selectPromptFromDropdown();
			});
			item.addEventListener('mouseenter', () => {
				this.promptDropdownIndex = i;
				this.updatePromptDropdownSelection();
			});
		}

		// Position above the input area
		const inputArea = this.inputEl.closest('.sidekick-input-area');
		if (inputArea) {
			inputArea.appendChild(this.promptDropdown);
		}
	}

	closePromptDropdown(): void {
		if (this.promptDropdown) {
			this.promptDropdown.remove();
			this.promptDropdown = null;
			this.promptDropdownIndex = -1;
		}
	}

	navigatePromptDropdown(direction: number): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		if (items.length === 0) return;
		this.promptDropdownIndex = (this.promptDropdownIndex + direction + items.length) % items.length;
		this.updatePromptDropdownSelection();
	}

	updatePromptDropdownSelection(): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.promptDropdownIndex);
		});
	}

	selectPromptFromDropdown(): void {
		if (!this.promptDropdown) return;
		const value = this.inputEl.value;
		const query = value.startsWith('/') ? value.slice(1).toLowerCase() : '';

		// Build merged list matching handlePromptTrigger
		const builtinMatches = SidekickView.BUILTIN_COMMANDS
			.filter(c => c.name.toLowerCase().includes(query))
			.map(c => ({name: c.name, description: c.description, content: '', isBuiltin: true as const}));
		const promptMatches = this.prompts
			.filter(p => p.name.toLowerCase().includes(query))
			.map(p => ({...p, isBuiltin: false as const}));
		const combined = [...builtinMatches, ...promptMatches];

		const selected = combined[this.promptDropdownIndex];
		if (!selected) {
			this.closePromptDropdown();
			return;
		}

		// Built-in commands execute immediately
		if (selected.isBuiltin) {
			this.closePromptDropdown();
			this.inputEl.value = '';
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.executeBuiltinCommand(selected.name);
			return;
		}

		this.activePrompt = selected;

		// Auto-select the prompt's agent
		if (selected.agent) {
			this.selectAgent(selected.agent);
		}

		// Replace input with /prompt-name + space
		this.inputEl.value = `/${selected.name} `;
		this.inputEl.setAttribute('title', selected.content);
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
		this.closePromptDropdown();
	}

	// ── Built-in slash commands ──────────────────────────────────

	executeBuiltinCommand(name: string, arg?: string): void {
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
	}

	showHelpInfo(): void {
		const commandLines = SidekickView.BUILTIN_COMMANDS.map(c => `  /${c.name} — ${c.description}`).join('\n');
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
	}

	showAgentsList(): void {
		if (this.agents.length === 0) {
			this.addInfoMessage('No agents configured. Add .agent.md files to your sidekick agents folder.');
			return;
		}
		const lines = this.agents.map(a => {
			const active = a.name === this.selectedAgent ? ' ✓' : '';
			return `  @${a.name}${active} — ${a.description || 'No description'}`;
		});
		this.addInfoMessage('**Available agents:**\n' + lines.join('\n') + '\n\nUse @agent-name in your message to delegate, or /agent name to switch.');
	}

	showModelsList(): void {
		if (this.models.length === 0) {
			this.addInfoMessage('No models available.');
			return;
		}
		const lines = this.models.map(m => {
			const active = m.id === this.selectedModel ? ' ✓' : '';
			return `  ${m.name || m.id}${active}`;
		});
		this.addInfoMessage('**Available models:**\n' + lines.join('\n') + '\n\nUse /model name to switch.');
	}

	async showReference(): Promise<void> {
		const helpPath = normalizePath(`${this.plugin.settings.sidekickFolder}/HELP.md`);
		const file = this.app.vault.getAbstractFileByPath(helpPath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			this.addInfoMessage(content);
		} else {
			// Generate in-line if HELP.md doesn't exist yet
			const {HELP_MD_CONTENT} = await import('./settings');
			this.addInfoMessage(HELP_MD_CONTENT);
		}
	}

	showTriggerDebug(): void {
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
	}

	showTasksOverview(): void {
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
	}

	// ── @agent mention handling ──────────────────────────────────

	handleAgentMentionTrigger(): void {
		if (this.agents.length === 0) {
			this.closeAgentDropdown();
			return;
		}

		const value = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart ?? value.length;

		// Find the last '@' before the cursor that is either at the start or preceded by a space
		let atPos = -1;
		for (let i = cursorPos - 1; i >= 0; i--) {
			if (value[i] === '@') {
				if (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\n') {
					atPos = i;
				}
				break;
			}
			// Stop scanning if we hit a space (the @mention must be contiguous)
			if (value[i] === ' ' || value[i] === '\n') break;
		}

		if (atPos === -1) {
			this.closeAgentDropdown();
			return;
		}

		const query = value.slice(atPos + 1, cursorPos).toLowerCase();
		const filtered = this.agents.filter(a => a.name.toLowerCase().includes(query));

		if (filtered.length === 0) {
			this.closeAgentDropdown();
			return;
		}

		this.agentMentionStart = atPos;
		this.showAgentDropdown(filtered);
	}

	showAgentDropdown(agents: AgentConfig[]): void {
		this.closeAgentDropdown();
		this.agentDropdown = document.createElement('div');
		this.agentDropdown.addClass('sidekick-prompt-dropdown sidekick-agent-dropdown');
		this.agentDropdownIndex = 0;

		for (let i = 0; i < agents.length; i++) {
			const a = agents[i];
			if (!a) continue;
			const item = this.agentDropdown.createDiv({cls: 'sidekick-prompt-item sidekick-agent-item'});
			if (i === 0) item.addClass('is-selected');
			item.setAttribute('title', a.description || a.instructions.slice(0, 100));

			const iconEl = item.createSpan({cls: 'sidekick-agent-item-icon'});
			setIcon(iconEl, 'bot');
			item.createSpan({cls: 'sidekick-prompt-item-name', text: `@${a.name}`});
			if (a.description) {
				const desc = a.description.length > 50 ? a.description.slice(0, 50) + '…' : a.description;
				item.createSpan({cls: 'sidekick-prompt-item-desc', text: desc});
			}

			item.addEventListener('click', () => {
				this.agentDropdownIndex = i;
				this.selectAgentFromDropdown();
			});
			item.addEventListener('mouseenter', () => {
				this.agentDropdownIndex = i;
				this.updateAgentDropdownSelection();
			});
		}

		const inputArea = this.inputEl.closest('.sidekick-input-area');
		if (inputArea) {
			inputArea.appendChild(this.agentDropdown);
		}
	}

	closeAgentDropdown(): void {
		if (this.agentDropdown) {
			this.agentDropdown.remove();
			this.agentDropdown = null;
			this.agentDropdownIndex = -1;
			this.agentMentionStart = -1;
		}
	}

	navigateAgentDropdown(direction: number): void {
		if (!this.agentDropdown) return;
		const items = this.agentDropdown.querySelectorAll('.sidekick-agent-item');
		if (items.length === 0) return;
		this.agentDropdownIndex = (this.agentDropdownIndex + direction + items.length) % items.length;
		this.updateAgentDropdownSelection();
	}

	updateAgentDropdownSelection(): void {
		if (!this.agentDropdown) return;
		const items = this.agentDropdown.querySelectorAll('.sidekick-agent-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.agentDropdownIndex);
		});
	}

	selectAgentFromDropdown(): void {
		if (!this.agentDropdown || this.agentMentionStart === -1) return;

		const value = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart ?? value.length;
		const query = value.slice(this.agentMentionStart + 1, cursorPos).toLowerCase();
		const filtered = this.agents.filter(a => a.name.toLowerCase().includes(query));
		const selected = filtered[this.agentDropdownIndex];
		if (!selected) {
			this.closeAgentDropdown();
			return;
		}

		// Replace the @query with @agentName + space
		const before = value.slice(0, this.agentMentionStart);
		const after = value.slice(cursorPos);
		const replacement = `@${selected.name} `;
		this.inputEl.value = before + replacement + after;

		// Move cursor to after the replacement
		const newPos = before.length + replacement.length;
		this.inputEl.setSelectionRange(newPos, newPos);
		this.inputEl.focus();
		this.closeAgentDropdown();
	}

	// ── Session sidebar ──────────────────────────────────────────

	buildSessionSidebar(parent: HTMLElement): void {
		this.sidebarEl = parent.createDiv({cls: 'sidekick-sidebar'});
		this.sidebarEl.setCssProps({'--sidebar-width': `${this.sidebarWidth}px`});

		// Header: new session button + filter + sort + search
		const header = this.sidebarEl.createDiv({cls: 'sidekick-sidebar-header'});

		const headerBtnRow = header.createDiv({cls: 'sidekick-sidebar-btn-row'});

		const newBtn = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-icon-btn sidekick-sidebar-new-btn',
			attr: {title: 'New session'},
		});
		setIcon(newBtn, 'plus');
		newBtn.addEventListener('click', () => void this.newConversation());

		this.sidebarFilterEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-filter-btn',
			attr: {title: 'Filter sessions by type'},
		});
		setIcon(this.sidebarFilterEl, 'filter');
		this.sidebarFilterEl.addEventListener('click', (e) => this.openSessionFilterMenu(e));
		this.updateFilterBadge();

		this.sidebarSortEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-sort-btn',
			attr: {title: 'Sort sessions'},
		});
		setIcon(this.sidebarSortEl, 'arrow-up-down');
		this.sidebarSortEl.addEventListener('click', (e) => this.openSessionSortMenu(e));
		this.updateSortBadge();

		this.sidebarRefreshEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-refresh-btn',
			attr: {title: 'Refresh sessions'},
		});
		setIcon(this.sidebarRefreshEl, 'refresh-cw');
		this.sidebarRefreshEl.addEventListener('click', () => {
			void this.loadSessions();
			void this.loadAllConfigs();
		});

		this.sidebarDeleteEl = headerBtnRow.createEl('button', {
			cls: 'clickable-icon sidekick-sidebar-delete-btn',
			attr: {title: 'Delete displayed sessions'},
		});
		setIcon(this.sidebarDeleteEl, 'trash-2');
		this.sidebarDeleteEl.addEventListener('click', () => this.confirmDeleteDisplayedSessions());

		this.sidebarSearchEl = header.createEl('input', {
			type: 'text',
			placeholder: 'Search…',
			cls: 'sidekick-sidebar-search',
		});
		this.sidebarSearchEl.addEventListener('input', () => {
			this.sessionFilter = this.sidebarSearchEl.value.toLowerCase();
			this.renderSessionList();
		});

		// Session list (scrollable)
		this.sidebarListEl = this.sidebarEl.createDiv({cls: 'sidekick-sidebar-list'});
	}

	initSplitter(): void {
		let startX = 0;
		let startWidth = 0;
		let dragging = false;

		const onMouseMove = (e: MouseEvent) => {
			if (!dragging) return;
			// Sidebar is on the right, so dragging left increases width
			const dx = startX - e.clientX;
			const newWidth = Math.max(40, Math.min(300, startWidth + dx));
			this.sidebarWidth = newWidth;
			this.sidebarEl.setCssProps({'--sidebar-width': `${newWidth}px`});
		};

		const onMouseUp = () => {
			dragging = false;
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
			this.splitterEl.removeClass('is-dragging');
			document.body.removeClass('sidekick-no-select');
			// Re-render session list once on drag end instead of every mousemove
			this.renderSessionList();
		};

		this.splitterEl.addEventListener('mousedown', (e) => {
			e.preventDefault();
			dragging = true;
			startX = e.clientX;
			startWidth = this.sidebarWidth;
			this.splitterEl.addClass('is-dragging');
			document.body.addClass('sidekick-no-select');
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		});

		this.register(() => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		});
	}

	async loadSessions(): Promise<void> {
		if (!this.plugin.copilot) return;
		try {
			this.sessionList = await this.plugin.copilot.listSessions();
			this.sortSessionList();
			this.renderSessionList();
		} catch {
			// silently ignore — session list stays as-is
		}
	}

	sortSessionList(): void {
		switch (this.sessionSort) {
			case 'modified':
				this.sessionList.sort((a, b) => {
					const ta = a.modifiedTime instanceof Date ? a.modifiedTime.getTime() : new Date(a.modifiedTime).getTime();
					const tb = b.modifiedTime instanceof Date ? b.modifiedTime.getTime() : new Date(b.modifiedTime).getTime();
					return tb - ta;
				});
				break;
			case 'created':
				this.sessionList.sort((a, b) => {
					const ta = a.startTime instanceof Date ? a.startTime.getTime() : new Date(a.startTime).getTime();
					const tb = b.startTime instanceof Date ? b.startTime.getTime() : new Date(b.startTime).getTime();
					return tb - ta;
				});
				break;
			case 'name':
				this.sessionList.sort((a, b) => {
					const na = this.getSessionDisplayName(a).toLowerCase();
					const nb = this.getSessionDisplayName(b).toLowerCase();
					return na.localeCompare(nb);
				});
				break;
		}
	}

	renderSessionList(): void {
		if (!this.sidebarListEl) return;
		this.sidebarListEl.empty();

		const isExpanded = this.sidebarWidth > 80;
		// Show/hide search and filter/sort/refresh when collapsed
		if (this.sidebarSearchEl) {
			this.sidebarSearchEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarFilterEl) {
			this.sidebarFilterEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarSortEl) {
			this.sidebarSortEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarRefreshEl) {
			this.sidebarRefreshEl.toggleClass('is-hidden', !isExpanded);
		}
		if (this.sidebarDeleteEl) {
			this.sidebarDeleteEl.toggleClass('is-hidden', !isExpanded);
		}

		for (const session of this.sessionList) {
			// Apply type filter
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) continue;
			}

			const name = this.getSessionDisplayName(session);
			if (this.sessionFilter && !name.toLowerCase().includes(this.sessionFilter)) continue;

			this.renderSessionItem(this.sidebarListEl, session, {
				expanded: isExpanded,
				onClick: () => void this.selectSession(session.sessionId),
				onContextMenu: (e) => this.showSessionContextMenu(e, session.sessionId),
			});
		}

		// Keep trigger history in sync with session list
		this.renderTriggerHistory();
	}

	/** Render a single session item into a container. Shared by session list and trigger history. */
	renderSessionItem(container: HTMLElement, session: SessionMetadata, opts: {
		expanded?: boolean;
		onClick: () => void;
		onContextMenu: (e: MouseEvent) => void;
	}): void {
		const expanded = opts.expanded ?? true;
		const item = container.createDiv({cls: 'sidekick-session-item'});
		const isActive = session.sessionId === this.currentSessionId;
		if (isActive) item.addClass('is-active');

		const sessionType = this.getSessionType(session);
		const iconName = sessionType === 'chat' ? 'message-square' : sessionType === 'trigger' ? 'zap' : sessionType === 'inline' ? 'file-text' : sessionType === 'search' ? 'search' : 'code';
		const iconEl = item.createSpan({cls: 'sidekick-session-icon'});
		setIcon(iconEl, iconName);

		// Green active dot when processing (current or background session)
		const isCurrentStreaming = isActive && this.isStreaming;
		const bgSession = this.activeSessions.get(session.sessionId);
		const isBgStreaming = bgSession?.isStreaming ?? false;
		if (isCurrentStreaming || isBgStreaming) {
			iconEl.createSpan({cls: 'sidekick-session-active-dot'});
		}

		const name = this.getSessionDisplayName(session);
		if (expanded) {
			const details = item.createDiv({cls: 'sidekick-session-details'});
			details.createDiv({cls: 'sidekick-session-name', text: name});
			const modTime = session.modifiedTime instanceof Date
				? session.modifiedTime
				: new Date(session.modifiedTime);
			details.createDiv({cls: 'sidekick-session-time', text: this.formatTimeAgo(modTime)});
		}

		item.setAttribute('title', name);
		item.addEventListener('click', opts.onClick);
		item.addEventListener('contextmenu', opts.onContextMenu);
	}

	getSessionDisplayName(session: SessionMetadata): string {
		const raw = this.sessionNames[session.sessionId]
			|| session.summary
			|| `Session ${session.sessionId.slice(0, 8)}`;
		// Strip session type prefix for display
		return raw.replace(/^\[(chat|inline|trigger(?::[a-z0-9-]+)?|search)\]\s*/, '');
	}

	/** Return the session type prefix: 'chat', 'inline', 'trigger', 'search', or 'other'. */
	getSessionType(session: SessionMetadata): 'chat' | 'inline' | 'trigger' | 'search' | 'other' {
		const name = this.sessionNames[session.sessionId] || '';
		debugTrace(`Sidekick: getSessionType id=${session.sessionId.slice(0, 8)} name="${name.slice(0, 40)}"`);
		if (name.startsWith('[chat]')) return 'chat';
		if (name.startsWith('[inline]')) return 'inline';
		if (name.startsWith('[trigger]') || name.startsWith('[trigger:')) return 'trigger';
		if (name.startsWith('[search]')) return 'search';
		return 'other';
	}

	openSessionFilterMenu(e: MouseEvent): void {
		const menu = new Menu();
		const types: Array<{value: 'chat' | 'inline' | 'trigger' | 'search' | 'other'; label: string}> = [
			{value: 'chat', label: 'Chat'},
			{value: 'trigger', label: 'Triggers'},
			{value: 'search', label: 'Search'},
			{value: 'inline', label: 'Inline'},
			{value: 'other', label: 'Other'},
		];
		for (const {value, label} of types) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionTypeFilter.has(value))
					.onClick(() => {
						if (this.sessionTypeFilter.has(value)) {
							this.sessionTypeFilter.delete(value);
						} else {
							this.sessionTypeFilter.add(value);
						}
						this.updateFilterBadge();
						this.renderSessionList();
					});
			});
		}
		menu.addSeparator();
		menu.addItem(item => {
			item.setTitle('Show all')
				.onClick(() => {
					this.sessionTypeFilter.clear();
					this.updateFilterBadge();
					this.renderSessionList();
				});
		});
		menu.showAtMouseEvent(e);
	}

	updateFilterBadge(): void {
		// When no types selected (show all), dim the icon; otherwise mark active
		const hasFilter = this.sessionTypeFilter.size > 0;
		this.sidebarFilterEl.toggleClass('is-active', hasFilter);
		this.sidebarFilterEl.setAttribute('title',
			hasFilter
				? `Filter: ${[...this.sessionTypeFilter].join(', ')}`
				: 'Filter sessions (showing all)');
	}

	openSessionSortMenu(e: MouseEvent): void {
		const menu = new Menu();
		const sorts: Array<{value: 'modified' | 'created' | 'name'; label: string}> = [
			{value: 'modified', label: 'Modified date'},
			{value: 'created', label: 'Created date'},
			{value: 'name', label: 'Name'},
		];
		for (const {value, label} of sorts) {
			menu.addItem(item => {
				item.setTitle(label)
					.setChecked(this.sessionSort === value)
					.onClick(() => {
						this.sessionSort = value;
						this.updateSortBadge();
						this.sortSessionList();
						this.renderSessionList();
					});
			});
		}
		menu.showAtMouseEvent(e);
	}

	updateSortBadge(): void {
		const labels: Record<string, string> = {modified: 'Modified', created: 'Created', name: 'Name'};
		this.sidebarSortEl.setAttribute('title', `Sort: ${labels[this.sessionSort]}`);
	}

	/**
	 * Public API: register an inline session so it appears in the sidebar.
	 * Called by editorMenu after completing an inline operation.
	 */
	public registerInlineSession(sessionId: string, description: string): void {
		this.sessionNames[sessionId] = `[inline] ${description}`;
		this.saveSessionNames();

		// Add to session list immediately so sidebar updates
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();
	}

	// ── Background session management ────────────────────────────

	/**
	 * Save the currently viewed session into the activeSessions map.
	 * If the session is streaming, events keep routing to the BackgroundSession.
	 * If idle, the session handle is preserved for quick switching.
	 */
	saveCurrentToBackground(): void {
		if (!this.currentSession || !this.currentSessionId) return;

		// Evict the oldest idle background session if at capacity
		const MAX_BACKGROUND_SESSIONS = 8;
		if (this.activeSessions.size >= MAX_BACKGROUND_SESSIONS) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [key, bg] of this.activeSessions) {
				if (bg.isStreaming) continue; // don't evict active streams
				const entry = this.sessionList.find(s => s.sessionId === key);
				const t = entry?.modifiedTime instanceof Date
					? entry.modifiedTime.getTime()
					: entry ? new Date(entry.modifiedTime).getTime() : 0;
				if (t < oldestTime) {
					oldestTime = t;
					oldestKey = key;
				}
			}
			if (oldestKey) {
				const evicted = this.activeSessions.get(oldestKey);
				if (evicted) {
					for (const unsub of evicted.unsubscribers) unsub();
					evicted.savedDom = null; // release DOM fragment
					try { void evicted.session.disconnect(); } catch { /* ignore */ }
					this.activeSessions.delete(oldestKey);
				}
			}
		}

		// Detach events from foreground routing
		this.unsubscribeEvents();

		// Save chat DOM into a DocumentFragment for fast restore
		const fragment = document.createDocumentFragment();
		while (this.chatContainer.firstChild) {
			fragment.appendChild(this.chatContainer.firstChild);
		}

		const bg: BackgroundSession = {
			sessionId: this.currentSessionId,
			session: this.currentSession,
			messages: [...this.messages],
			isStreaming: this.isStreaming,
			streamingContent: this.streamingContent,
			savedDom: fragment,
			unsubscribers: [],
			turnStartTime: this.turnStartTime,
			turnToolsUsed: [...this.turnToolsUsed],
			turnSkillsUsed: [...this.turnSkillsUsed],
			turnUsage: this.turnUsage ? {...this.turnUsage} : null,
			activeToolCalls: new Map(this.activeToolCalls),
			streamingComponent: this.streamingComponent,
			streamingBodyEl: this.streamingBodyEl,
			streamingWrapperEl: this.streamingWrapperEl,
			toolCallsContainer: this.toolCallsContainer,
		};

		// If still streaming, attach background event routing
		if (bg.isStreaming) {
			this.registerBackgroundEvents(bg);
		}

		this.activeSessions.set(this.currentSessionId, bg);

		// Detach streaming component from the view (it lives in the bg now)
		if (this.streamingComponent) {
			this.streamingComponent = null;
		}
		this.currentSession = null;
		this.currentSessionId = null;
	}

	/**
	 * Restore a BackgroundSession as the foreground session.
	 */
	async restoreFromBackground(bg: BackgroundSession): Promise<void> {
		// Unsubscribe background event routing
		for (const unsub of bg.unsubscribers) unsub();
		bg.unsubscribers = [];

		// Restore state
		this.currentSession = bg.session;
		this.currentSessionId = bg.sessionId;
		this.messages = bg.messages;
		this.isStreaming = bg.isStreaming;
		this.streamingContent = bg.streamingContent;
		this.turnStartTime = bg.turnStartTime;
		this.turnToolsUsed = bg.turnToolsUsed;
		this.turnSkillsUsed = bg.turnSkillsUsed;
		this.turnUsage = bg.turnUsage;
		this.configDirty = false;

		this.chatContainer.empty();

		if (bg.isStreaming && bg.savedDom) {
			// Session is still streaming — restore its live DOM (including streaming placeholder)
			this.streamingComponent = bg.streamingComponent;
			this.streamingBodyEl = bg.streamingBodyEl;
			this.streamingWrapperEl = bg.streamingWrapperEl;
			this.toolCallsContainer = bg.toolCallsContainer;
			this.activeToolCalls = bg.activeToolCalls;
			this.chatContainer.appendChild(bg.savedDom);
			bg.savedDom = null;
			// Re-render the streaming content that accumulated while in background
			if (this.streamingContent && this.streamingBodyEl) {
				void this.updateStreamingRender();
			}
		} else {
			// Session finished while in background — re-render messages from scratch
			this.streamingComponent = null;
			this.streamingBodyEl = null;
			this.streamingWrapperEl = null;
			this.toolCallsContainer = null;
			this.activeToolCalls.clear();
			const renderPromises: Promise<void>[] = [];
			for (const msg of this.messages) {
				renderPromises.push(this.renderMessageBubble(msg));
			}
			await Promise.all(renderPromises);
			if (this.messages.length === 0) {
				this.renderWelcome();
			}
		}

		// Re-attach foreground event routing
		this.registerSessionEvents();

		// Lock toolbar since session is active
		this.updateToolbarLock();

		// Remove from background map
		this.activeSessions.delete(bg.sessionId);

		// Restore agent from session name
		this.restoreAgentFromSessionName(bg.sessionId);

		// Force scroll to end
		this.forceScrollToBottom();
	}

	/**
	 * Register event handlers that route session events into a BackgroundSession
	 * object while the session is not being viewed.
	 */
	registerBackgroundEvents(bg: BackgroundSession): void {
		const session = bg.session;

		bg.unsubscribers.push(
			session.on('assistant.turn_start', () => {
				if (bg.turnStartTime === 0) bg.turnStartTime = Date.now();
			}),
			session.on('assistant.message_delta', (event) => {
				bg.streamingContent += event.data.deltaContent;
				// No DOM rendering — session is hidden
			}),
			session.on('assistant.message', () => { /* accumulated via deltas */ }),
			session.on('assistant.usage', (event) => {
				const d = event.data;
				if (!bg.turnUsage) {
					bg.turnUsage = {
						inputTokens: d.inputTokens ?? 0,
						outputTokens: d.outputTokens ?? 0,
						cacheReadTokens: d.cacheReadTokens ?? 0,
						cacheWriteTokens: d.cacheWriteTokens ?? 0,
						model: d.model,
					};
				} else {
					bg.turnUsage.inputTokens += d.inputTokens ?? 0;
					bg.turnUsage.outputTokens += d.outputTokens ?? 0;
					bg.turnUsage.cacheReadTokens += d.cacheReadTokens ?? 0;
					bg.turnUsage.cacheWriteTokens += d.cacheWriteTokens ?? 0;
					if (d.model) bg.turnUsage.model = d.model;
				}
			}),
			session.on('session.idle', () => {
				// Finalize the background streaming turn
				if (bg.streamingContent) {
					bg.messages.push({
						id: `a-${Date.now()}`,
						role: 'assistant',
						content: bg.streamingContent,
						timestamp: Date.now(),
					});
				}
				bg.streamingContent = '';
				bg.streamingBodyEl = null;
				bg.streamingWrapperEl = null;
				bg.toolCallsContainer = null;
				bg.activeToolCalls.clear();
				bg.streamingComponent = null;
				bg.turnStartTime = 0;
				bg.turnToolsUsed = [];
				bg.turnSkillsUsed = [];
				bg.turnUsage = null;
				bg.isStreaming = false;
				// Re-render sidebar to remove the green dot
				this.renderSessionList();
				void this.loadSessions();
			}),
			session.on('session.error', (event) => {
				bg.messages.push({
					id: `i-${Date.now()}`,
					role: 'info',
					content: `Error: ${event.data.message}`,
					timestamp: Date.now(),
				});
				bg.isStreaming = false;
				bg.streamingContent = '';
				bg.streamingBodyEl = null;
				bg.streamingWrapperEl = null;
				bg.toolCallsContainer = null;
				bg.activeToolCalls.clear();
				bg.streamingComponent = null;
				this.renderSessionList();
			}),
			session.on('tool.execution_start', (event) => {
				bg.turnToolsUsed.push(event.data.toolName);
				// No DOM manipulation — hidden session
			}),
			session.on('tool.execution_complete', () => {
				// No DOM manipulation — hidden session
			}),
			session.on('skill.invoked', (event) => {
				bg.turnSkillsUsed.push(event.data.name);
			}),
			session.on('session.info', (event) => {
				this.handleMcpSessionEvent(event.data.infoType, event.data.message, 'info');
			}),
			session.on('session.warning', (event) => {
				this.handleMcpSessionEvent(event.data.warningType, event.data.message, 'warning');
			}),
		);
	}

	/**
	 * Restore the agent and model dropdowns from a session's saved name.
	 */
	restoreAgentFromSessionName(sessionId: string): void {
		let sessionName = this.sessionNames[sessionId] || '';
		// Strip session type prefix
		sessionName = sessionName.replace(/^\[(chat|inline|trigger)\]\s*/, '');
		const colonIdx = sessionName.indexOf(':');
		if (colonIdx > 0) {
			const agentName = sessionName.substring(0, colonIdx).trim();
			if (this.agents.some(a => a.name === agentName)) {
				this.selectAgent(agentName);
			}
		}
	}

	async selectSession(sessionId: string): Promise<void> {
		if (sessionId === this.currentSessionId && this.currentSession) return;

		// ── Save current session to background (if streaming, keep it alive) ──
		if (this.currentSession && this.currentSessionId) {
			this.saveCurrentToBackground();
		}

		// Clear UI for the new session
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
		this.chatContainer.empty();

		// ── Check if the target session is already alive in background ──
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			await this.restoreFromBackground(bg);
			this.renderSessionList();
			this.updateSendButton();
			return;
		}

		// ── Otherwise, resume from SDK (cold load) ──

		try {
			// Build full session config so skills, MCP servers, etc. are available
			const agent = this.agents.find(a => a.name === this.selectedAgent);
			const sessionConfig = this.buildSessionConfig({
				model: this.selectedModel || undefined,
				systemContent: agent?.instructions || undefined,
			});

			this.currentSession = await this.plugin.copilot!.resumeSession(sessionId, {
				...sessionConfig,
			});
			this.currentSessionId = sessionId;
			this.configDirty = false;
			this.registerSessionEvents();
			this.updateToolbarLock();

			// Load and render message history from SDK
			const events = await this.currentSession.getMessages();
			const renderPromises: Promise<void>[] = [];
			for (const event of events) {
				if (event.type === 'user.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'user',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					renderPromises.push(this.renderMessageBubble(msg));
				} else if (event.type === 'assistant.message') {
					const msg: ChatMessage = {
						id: event.id,
						role: 'assistant',
						content: event.data.content,
						timestamp: new Date(event.timestamp).getTime(),
					};
					this.messages.push(msg);
					renderPromises.push(this.renderMessageBubble(msg));
				}
			}
			await Promise.all(renderPromises);

			if (this.messages.length === 0) {
				this.renderWelcome();
			}

			// Restore the agent that was used in this session
			this.restoreAgentFromSessionName(sessionId);

			// Force scroll to the end of the loaded conversation
			this.forceScrollToBottom();

			this.renderSessionList();
			this.updateSendButton();
		} catch (e) {
			this.addInfoMessage(`Failed to load session: ${String(e)}`);
			this.renderWelcome();
			this.currentSessionId = null;
			this.renderSessionList();
		}
	}

	showSessionContextMenu(e: MouseEvent, sessionId: string): void {
		e.preventDefault();
		e.stopPropagation();
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Rename')
			.setIcon('pencil')
			.onClick(() => this.renameSession(sessionId)));

		menu.addItem(item => item
			.setTitle('Delete')
			.setIcon('trash-2')
			.onClick(() => void this.deleteSessionById(sessionId)));

		menu.showAtMouseEvent(e);
	}

	renameSession(sessionId: string): void {
		const rawName = this.sessionNames[sessionId] || '';
		// Extract prefix and display name
		const prefixMatch = rawName.match(/^(\[(chat|inline|trigger)\]\s*)/);
		const prefix = prefixMatch ? prefixMatch[1] : '';
		const displayName = prefix ? rawName.slice(prefix.length) : rawName;

		const modal = new Modal(this.app);
		modal.titleEl.setText('Rename session');

		const input = modal.contentEl.createEl('input', {
			type: 'text',
			value: displayName,
			cls: 'sidekick-rename-input',
		});


		const btnRow = modal.contentEl.createDiv({cls: 'sidekick-approval-buttons'});
		const saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		saveBtn.addEventListener('click', () => {
			const newName = input.value.trim();
			if (newName) {
				this.sessionNames[sessionId] = `${prefix}${newName}`;
				this.saveSessionNames();
				this.renderSessionList();
			}
			modal.close();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => modal.close());

		// Enter key to save
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				saveBtn.click();
			}
		});

		modal.open();
		input.focus();
		input.select();
	}

	async deleteSessionById(sessionId: string): Promise<void> {
		// Clean up background session if it exists
		const bg = this.activeSessions.get(sessionId);
		if (bg) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
			this.activeSessions.delete(sessionId);
		}

		try {
			await this.plugin.copilot!.deleteSession(sessionId);
		} catch (e) {
			new Notice(`Failed to delete session: ${String(e)}`);
			return;
		}

		delete this.sessionNames[sessionId];
		this.saveSessionNames();
		this.sessionList = this.sessionList.filter(s => s.sessionId !== sessionId);

		if (this.currentSessionId === sessionId) {
			this.currentSessionId = null;
			this.currentSession = null;
			this.newConversation();
		}

		this.renderSessionList();
		new Notice('Session deleted.');
	}

	confirmDeleteDisplayedSessions(): void {
		const displayed = this.getDisplayedSessions();
		if (displayed.length === 0) {
			new Notice('No sessions to delete.');
			return;
		}

		const modal = new Modal(this.app);
		modal.titleEl.setText('Delete sessions');
		modal.contentEl.createEl('p', {
			text: `Are you sure you want to delete ${displayed.length} session${displayed.length === 1 ? '' : 's'}?`,
		});
		const btnRow = modal.contentEl.createDiv({cls: 'modal-button-container'});
		btnRow.createEl('button', {text: 'Cancel', cls: 'mod-cancel'}).addEventListener('click', () => modal.close());
		const confirmBtn = btnRow.createEl('button', {text: 'Delete', cls: 'mod-warning'});
		confirmBtn.addEventListener('click', () => {
			modal.close();
			void this.deleteDisplayedSessions(displayed);
		});
		modal.open();
	}

	getDisplayedSessions(): SessionMetadata[] {
		return this.sessionList.filter(session => {
			if (this.sessionTypeFilter.size > 0) {
				const type = this.getSessionType(session);
				if (!this.sessionTypeFilter.has(type)) return false;
			}
			if (this.sessionFilter) {
				const name = this.getSessionDisplayName(session);
				if (!name.toLowerCase().includes(this.sessionFilter)) return false;
			}
			return true;
		});
	}

	async deleteDisplayedSessions(sessions: SessionMetadata[]): Promise<void> {
		let deleted = 0;
		for (const session of sessions) {
			try {
				await this.deleteSessionById(session.sessionId);
				deleted++;
			} catch { /* continue with remaining */ }
		}
		new Notice(`Deleted ${deleted} session${deleted === 1 ? '' : 's'}.`);
	}

	saveSessionNames(): void {
		this.plugin.settings.sessionNames = {...this.sessionNames};
		void this.plugin.saveSettings();
	}

	formatTimeAgo(d: Date): string {
		const now = Date.now();
		const diff = now - d.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (minutes < 1) return 'Just now';
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days === 1) return 'Yesterday';
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString();
	}

	// ── Tools panel ─────────────────────────────────────────────

	buildToolsPanel(parent: HTMLElement): void {
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
				void this.loadAllConfigs({silent: true}).then(() => this.renderToolsPanel());
			}).open();
		});
		const refreshBtn = mcpControls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh'},
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => {
			void this.loadAllConfigs({silent: true}).then(() => this.renderToolsPanel());
		});
		this.toolsMcpListEl = mcpSection.createDiv({cls: 'sidekick-tools-list'});

		// ── Agent tool mappings section ──────────────────────
		const agentSection = wrapper.createDiv({cls: 'sidekick-tools-section'});
		const agentHeader = agentSection.createDiv({cls: 'sidekick-tools-header'});
		agentHeader.createDiv({cls: 'sidekick-tools-title', text: 'Agent tool access'});
		const agentControls = agentHeader.createDiv({cls: 'sidekick-tools-controls'});
		const newAgentBtn = agentControls.createEl('button', {cls: 'clickable-icon sidekick-triggers-ctrl-btn', attr: {title: 'New agent'}});
		setIcon(newAgentBtn, 'plus');
		newAgentBtn.addEventListener('click', () => this.openAgentEditor());
		this.toolsAgentListEl = agentSection.createDiv({cls: 'sidekick-tools-list'});
	}

	renderToolsPanel(): void {
		this.renderMcpServersList();
		this.renderAgentToolMappings();
	}

	renderMcpServersList(): void {
		this.toolsMcpListEl.empty();

		if (this.mcpServers.length === 0) {
			const empty = this.toolsMcpListEl.createDiv({cls: 'sidekick-tools-empty'});
			empty.createSpan({text: 'No MCP servers configured. '});
			const hint = empty.createSpan({cls: 'sidekick-tools-hint'});
			hint.setText(`Add servers to ${this.plugin.settings.sidekickFolder}/tools/mcp.json`);
			return;
		}

		for (const server of this.mcpServers) {
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

			// Connection status message when there's an error
			if (runtimeStatus?.status === 'error' && runtimeStatus.message) {
				const errMsg = info.createDiv({cls: 'sidekick-tools-item-error'});
				errMsg.setText(runtimeStatus.message);
			}

			const meta = info.createDiv({cls: 'sidekick-tools-item-meta'});

			// Server type
			const cfg = server.config;
			const serverType = (cfg['type'] as string | undefined) ?? (cfg['command'] ? 'local' : 'unknown');
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
				if (checkbox.checked) {
					this.enabledMcpServers.add(server.name);
				} else {
					this.enabledMcpServers.delete(server.name);
				}
				toggleContainer.toggleClass('is-enabled', checkbox.checked);
				this.configDirty = true;
				this.updateToolsBadge();
				this.renderMcpServersList();
				this.renderAgentToolMappings();
			});
		}
	}

	renderAgentToolMappings(): void {
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

			const toolsList = item.createDiv({cls: 'sidekick-tools-agent-tools'});

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
		}
	}

	/**
	 * Handle session.info and session.warning events related to MCP servers.
	 * Updates mcpServerStatus map and refreshes the Tools panel if visible.
	 */
	handleMcpSessionEvent(category: string, message: string, level: 'info' | 'warning'): void {
		if (category !== 'mcp') return;

		// Parse server name from typical MCP messages like "MCP server 'name': connected"
		// or "MCP server 'name': auth required" etc.
		const serverMatch = message.match(/MCP server ['"]?([^'":\s]+)['"]?\s*:\s*(.*)/i)
			?? message.match(/(?:connected|failed|error|started|auth\w*)\s+(?:MCP server\s+)?['"]?([^'":\s]+)['"]?/i);

		if (serverMatch) {
			const serverName = serverMatch[1]!;
			const detail = serverMatch[2] || '';
			const lowerMsg = (detail || message).toLowerCase();

			if (lowerMsg.includes('connect') && !lowerMsg.includes('fail') && !lowerMsg.includes('error') && !lowerMsg.includes('disconnect')) {
				this.mcpServerStatus.set(serverName, {status: 'connected', message});
			} else if (lowerMsg.includes('error') || lowerMsg.includes('fail') || lowerMsg.includes('auth') || lowerMsg.includes('sign')) {
				this.mcpServerStatus.set(serverName, {status: 'error', message});
			} else {
				this.mcpServerStatus.set(serverName, {status: 'pending', message});
			}
		}

		// Surface warnings/errors as info messages in chat
		if (level === 'warning') {
			this.addInfoMessage(`MCP: ${message}`);
		}

		// Refresh Tools panel if visible
		if (this.activeTab === 'tools') {
			this.renderMcpServersList();
		}
	}

	// ── Search panel ────────────────────────────────────────────

	buildSearchPanel(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-search-wrapper'});

		// ── Toolbar row: scope | mode toggle | [advanced: agent | model | skills | tools] ──
		const toolbar = wrapper.createDiv({cls: 'sidekick-toolbar sidekick-search-toolbar'});

		// Search scope (folder picker) — always visible
		this.searchCwdBtnEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Search scope'}});
		setIcon(this.searchCwdBtnEl, 'folder');
		this.searchCwdBtnEl.addEventListener('click', () => this.openSearchScopePicker());
		this.updateSearchCwdButton();

		// Mode toggle (basic / advanced)
		this.searchModeToggleEl = toolbar.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Toggle basic/advanced mode'}});
		this.searchModeToggleEl.addEventListener('click', () => this.toggleSearchMode());
		this.updateSearchModeToggle();

		// Advanced controls group — hidden in basic mode
		this.searchAdvancedToolbarEl = toolbar.createDiv({cls: 'sidekick-search-advanced-group'});

		// Agent dropdown
		const agentGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const agentIcon = agentGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(agentIcon, 'bot');
		this.searchAgentSelect = agentGroup.createEl('select', {cls: 'sidekick-select'});
		this.searchAgentSelect.addEventListener('change', () => {
			this.searchAgent = this.searchAgentSelect.value;
			const agent = this.agents.find(a => a.name === this.searchAgent);
			this.searchAgentSelect.title = agent ? agent.instructions : '';
			// Auto-select agent's preferred model
			const resolvedModel = this.resolveModelForAgent(agent, this.searchModel || undefined);
			if (resolvedModel && resolvedModel !== this.searchModel) {
				this.searchModel = resolvedModel;
				this.searchModelSelect.value = resolvedModel;
			}
			// Apply agent's tools and skills filter for search
			this.applySearchAgentToolsAndSkills(agent);
			// Persist
			this.plugin.settings.searchAgent = this.searchAgent;
			void this.plugin.saveSettings();
		});

		// Model dropdown
		const modelGroup = this.searchAdvancedToolbarEl.createDiv({cls: 'sidekick-toolbar-group'});
		const modelIcon = modelGroup.createSpan({cls: 'sidekick-toolbar-icon'});
		setIcon(modelIcon, 'cpu');
		this.searchModelSelect = modelGroup.createEl('select', {cls: 'sidekick-select sidekick-model-select'});
		this.searchModelSelect.addEventListener('change', () => {
			this.searchModel = this.searchModelSelect.value;
		});

		// Skills button
		this.searchSkillsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Skills'}});
		setIcon(this.searchSkillsBtnEl, 'wand-2');
		this.searchSkillsBtnEl.addEventListener('click', (e) => this.openSearchSkillsMenu(e));

		// Tools button
		this.searchToolsBtnEl = this.searchAdvancedToolbarEl.createEl('button', {cls: 'clickable-icon sidekick-icon-btn', attr: {title: 'Tools'}});
		setIcon(this.searchToolsBtnEl, 'plug');
		this.searchToolsBtnEl.addEventListener('click', (e) => this.openSearchToolsMenu(e));

		// Apply initial visibility
		this.updateSearchAdvancedVisibility();

		// ── Search input + button ──
		const inputRow = wrapper.createDiv({cls: 'sidekick-search-input-row'});
		this.searchInputEl = inputRow.createEl('textarea', {
			cls: 'sidekick-search-input',
			attr: {placeholder: 'Describe what you\'re looking for…', rows: '2'},
		});
		this.searchInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.handleSearch();
			}
		});

		this.searchBtnEl = inputRow.createEl('button', {cls: 'sidekick-search-btn', attr: {title: 'Search'}});
		setIcon(this.searchBtnEl, 'search');
		this.searchBtnEl.addEventListener('click', () => void this.handleSearch());

		// ── Results area ──
		this.searchResultsEl = wrapper.createDiv({cls: 'sidekick-search-results'});
	}

	get searchMode(): 'basic' | 'advanced' {
		return this.plugin.settings.searchMode;
	}

	toggleSearchMode(): void {
		const newMode = this.searchMode === 'basic' ? 'advanced' : 'basic';
		this.plugin.settings.searchMode = newMode;
		void this.plugin.saveSettings();
		this.updateSearchModeToggle();
		this.updateSearchAdvancedVisibility();
		// Disconnect cached basic session when switching modes
		if (newMode === 'advanced' && this.basicSearchSession) {
			void this.basicSearchSession.disconnect().catch(() => {});
			this.basicSearchSession = null;
		}
	}

	updateSearchModeToggle(): void {
		this.searchModeToggleEl.empty();
		if (this.searchMode === 'basic') {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Basic mode (fast) — click for advanced';
		} else {
			setIcon(this.searchModeToggleEl, 'settings');
			this.searchModeToggleEl.title = 'Advanced mode — click for basic (fast)';
		}
		this.searchModeToggleEl.toggleClass('is-active', this.searchMode === 'advanced');
	}

	updateSearchAdvancedVisibility(): void {
		this.searchAdvancedToolbarEl.toggleClass('is-hidden', this.searchMode !== 'advanced');
	}

	updateSearchConfigUI(): void {
		// Agents
		this.searchAgentSelect.empty();
		const noAgent = this.searchAgentSelect.createEl('option', {text: 'Agent', attr: {value: ''}});
		noAgent.value = '';
		for (const agent of this.agents) {
			const opt = this.searchAgentSelect.createEl('option', {text: agent.name});
			opt.value = agent.name;
			opt.title = agent.instructions;
		}

		// Restore saved search agent from settings
		const savedAgent = this.plugin.settings.searchAgent;
		if (savedAgent && this.agents.some(a => a.name === savedAgent)) {
			this.searchAgent = savedAgent;
			this.searchAgentSelect.value = savedAgent;
			const selAgent = this.agents.find(a => a.name === savedAgent);
			this.searchAgentSelect.title = selAgent ? selAgent.instructions : '';
		}

		// Auto-select agent's preferred model
		const agentConfig = this.agents.find(a => a.name === this.searchAgent);
		const resolvedModel = this.resolveModelForAgent(agentConfig, this.searchModel || undefined);
		if (resolvedModel) {
			this.searchModel = resolvedModel;
		}

		// Models
		this.searchModelSelect.empty();
		for (const model of this.models) {
			const opt = this.searchModelSelect.createEl('option', {text: model.name});
			opt.value = model.id;
		}
		if (this.searchModel && this.models.some(m => m.id === this.searchModel)) {
			this.searchModelSelect.value = this.searchModel;
		} else if (this.models.length > 0 && this.models[0]) {
			this.searchModel = this.models[0].id;
			this.searchModelSelect.value = this.searchModel;
		}

		// Apply agent's tools and skills filter
		this.applySearchAgentToolsAndSkills(agentConfig);
	}

	applySearchAgentToolsAndSkills(agent?: AgentConfig): void {
		// Tools: undefined = enable all, [] = disable all, [...] = enable listed.
		// Agent names in the tools list are sub-agent references, not MCP servers.
		if (agent?.tools !== undefined) {
			const agentNames = new Set(this.agents.map(a => a.name));
			const mcpOnly = agent.tools.filter(t => !agentNames.has(t));
			const allowed = new Set(mcpOnly);
			this.searchEnabledMcpServers = new Set(
				this.mcpServers.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledMcpServers = new Set(this.mcpServers.map(s => s.name));
		}

		// Skills: undefined = enable all, [] = disable all, [...] = enable listed
		if (agent?.skills !== undefined) {
			const allowed = new Set(agent.skills);
			this.searchEnabledSkills = new Set(
				this.skills.filter(s => allowed.has(s.name)).map(s => s.name)
			);
		} else {
			this.searchEnabledSkills = new Set(this.skills.map(s => s.name));
		}

		this.updateSearchSkillsBadge();
		this.updateSearchToolsBadge();
	}

	openSearchSkillsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.skills.length === 0) {
			menu.addItem(item => item.setTitle('No skills configured').setDisabled(true));
		} else {
			for (const skill of this.skills) {
				menu.addItem(item => {
					item.setTitle(skill.name)
						.setChecked(this.searchEnabledSkills.has(skill.name))
						.onClick(() => {
							if (this.searchEnabledSkills.has(skill.name)) {
								this.searchEnabledSkills.delete(skill.name);
							} else {
								this.searchEnabledSkills.add(skill.name);
							}
							this.updateSearchSkillsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	openSearchToolsMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.mcpServers.length === 0) {
			menu.addItem(item => item.setTitle('No tools configured').setDisabled(true));
		} else {
			for (const server of this.mcpServers) {
				menu.addItem(item => {
					item.setTitle(server.name)
						.setChecked(this.searchEnabledMcpServers.has(server.name))
						.onClick(() => {
							if (this.searchEnabledMcpServers.has(server.name)) {
								this.searchEnabledMcpServers.delete(server.name);
							} else {
								this.searchEnabledMcpServers.add(server.name);
							}
							this.updateSearchToolsBadge();
						});
				});
			}
		}
		menu.showAtMouseEvent(e);
	}

	updateSearchSkillsBadge(): void {
		const count = this.searchEnabledSkills.size;
		this.searchSkillsBtnEl.toggleClass('is-active', count > 0);
		this.searchSkillsBtnEl.setAttribute('title', count > 0 ? `Skills (${count} active)` : 'Skills');
	}

	updateSearchToolsBadge(): void {
		const count = this.searchEnabledMcpServers.size;
		this.searchToolsBtnEl.toggleClass('is-active', count > 0);
		this.searchToolsBtnEl.setAttribute('title', count > 0 ? `Tools (${count} active)` : 'Tools');
	}

	openSearchScopePicker(): void {
		new FolderTreeModal(this.app, this.searchWorkingDir, (folder) => {
			this.searchWorkingDir = folder.path;
			this.updateSearchCwdButton();
		}).open();
	}

	updateSearchCwdButton(): void {
		const vaultName = this.app.vault.getName();
		const label = this.searchWorkingDir
			? `Search scope: ${vaultName}/${this.searchWorkingDir}`
			: `Search scope: ${vaultName} (entire vault)`;
		this.searchCwdBtnEl.setAttribute('title', label);
		this.searchCwdBtnEl.toggleClass('is-active', !!this.searchWorkingDir);
	}

	getSearchWorkingDirectory(): string {
		const base = this.getVaultBasePath();
		if (!this.searchWorkingDir) return base;
		return base + '/' + normalizePath(this.searchWorkingDir);
	}

	buildSearchSessionConfig(): SessionConfig {
		const basePath = this.getVaultBasePath();

		// MCP servers (search-specific selection)
		const mcpServers: Record<string, MCPServerConfig> = {};
		for (const server of this.mcpServers) {
			if (!this.searchEnabledMcpServers.has(server.name)) continue;
			const cfg = server.config;
			const serverType = cfg['type'] as string | undefined;
			const tools = (cfg['tools'] as string[] | undefined) ?? ['*'];

			if (serverType === 'http' || serverType === 'sse') {
				mcpServers[server.name] = {
					type: serverType,
					url: cfg['url'] as string,
					tools,
					...(cfg['headers'] ? {headers: cfg['headers'] as Record<string, string>} : {}),
					...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
				} as MCPServerConfig;
			} else if (cfg['command']) {
				mcpServers[server.name] = {
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

		// Skills
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.searchEnabledSkills.has(s.name))
			.map(s => s.name);

		// Custom agents — always pass all agents so the model can delegate via subagent.
		// The agent tools field can contain MCP server names AND/OR other agent names.
		const agentNameSet = new Set(this.agents.map(ag => ag.name));
		const customAgents: CustomAgentConfig[] = this.agents.map(a => {
			let agentMcpServers: Record<string, MCPServerConfig> | undefined;
			if (a.tools !== undefined && a.tools.length > 0) {
				const scoped: Record<string, MCPServerConfig> = {};
				for (const entry of a.tools) {
					if (!agentNameSet.has(entry) && mcpServers[entry]) {
						scoped[entry] = mcpServers[entry];
					}
				}
				if (Object.keys(scoped).length > 0) agentMcpServers = scoped;
			}
			let prompt = a.instructions;
			const subAgents = this.agents.filter(ag => {
				if (ag.name === a.name) return false;
				if (a.handoffs !== undefined) return a.handoffs.some(h => h.agent === ag.name);
				return true;
			});
			if (subAgents.length > 0) {
				const agentDescs = subAgents.map(ag => {
					const handoff = a.handoffs?.find(h => h.agent === ag.name);
					const base = ag.description ? `- **${ag.name}**: ${ag.description}` : `- **${ag.name}**`;
					return handoff?.prompt ? `${base}\n  Handoff instructions: ${handoff.prompt}` : base;
				}).join('\n');
				prompt += `\n\nYou can delegate tasks to the following sub-agents by invoking them as tools:\n${agentDescs}`;
			}
			return {
				name: a.name,
				displayName: a.name,
				description: a.description || undefined,
				prompt,
				tools: (a.tools !== undefined && a.tools.length === 0) ? [] : null,
				...(agentMcpServers ? {mcpServers: agentMcpServers} : {}),
				infer: true,
			};
		});

		// Permission handler
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai', azure: 'azure', anthropic: 'anthropic',
				ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
			};
			provider = {
				type: typeMap[providerPreset] ?? 'openai',
				baseUrl: this.plugin.settings.providerBaseUrl,
				...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
				...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
				wireApi: this.plugin.settings.providerWireApi,
			};
		}

		// Build system message: global instructions + MCP tool guidance for search sessions
		const mcpServerNames = Object.keys(mcpServers);
		const searchSystemParts: string[] = [];
		if (this.globalInstructions) {
			searchSystemParts.push(this.globalInstructions);
		}
		if (mcpServerNames.length > 0) {
			searchSystemParts.push(
				'You have access to MCP tool servers: ' + mcpServerNames.join(', ') + '.\n' +
				'Prefer using MCP tools over shell commands or direct file reads when the MCP servers provide equivalent functionality. ' +
				'Only fall back to shell commands when no MCP tool can accomplish the task.'
			);
		}
		const searchSystemContent = searchSystemParts.length > 0 ? searchSystemParts.join('\n\n') : undefined;

		debugTrace('buildSearchSessionConfig', {
			mcpServerCount: mcpServerNames.length,
			mcpServerNames,
			customAgentCount: customAgents.length,
			skillDirCount: skillDirs.length,
		});

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : (this.searchModel || undefined),
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
			...(mcpServerNames.length > 0 ? {mcpServers} : {}),
			...(customAgents.length > 0 ? {customAgents} : {}),
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(searchSystemContent ? {systemMessage: {mode: 'append' as const, content: searchSystemContent}} : {}),
		};
	}

	async handleSearch(): Promise<void> {
		if (this.isSearching) {
			// Cancel in-progress search
			const session = this.searchMode === 'basic' ? this.basicSearchSession : this.searchSession;
			if (session) {
				try { await session.abort(); } catch { /* ignore */ }
			}
			if (this.searchMode === 'advanced' && this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
			this.isSearching = false;
			this.updateSearchButton();
			return;
		}

		const query = this.searchInputEl.value.trim();
		if (!query) return;

		if (!this.plugin.copilot) {
			new Notice('Copilot is not configured.');
			return;
		}

		this.isSearching = true;
		this.updateSearchButton();
		this.searchResultsEl.empty();
		this.searchResultsEl.createDiv({cls: 'sidekick-search-loading', text: 'Searching…'});

		try {
			if (this.searchMode === 'basic') {
				await this.handleBasicSearch(query);
			} else {
				await this.handleAdvancedSearch(query);
			}
		} catch (e) {
			if (this.isSearching) {
				this.searchResultsEl.empty();
				this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: `Search failed: ${String(e)}`});
			}
		} finally {
			this.isSearching = false;
			this.updateSearchButton();
		}
	}

	async handleBasicSearch(query: string): Promise<void> {
		// Check cache first
		const scopePath = this.getSearchWorkingDirectory();
		const cacheKey = this.buildSearchCacheKey(query, 'basic', [scopePath]);
		const cached = this.searchCache.get(cacheKey);
		if (cached && Date.now() - cached.cachedAt < SidekickView.SEARCH_CACHE_TTL) {
			this.renderSearchResults(cached.content, true);
			return;
		}

		// Phase 1: Local pre-filter using metadata (instant)
		const candidates = this.vaultIndex?.preFilter(query, [this.searchWorkingDir || '/'], 25) ?? [];

		// Reuse persistent session; create only if missing
		if (!this.basicSearchSession) {
			this.basicSearchSession = await this.plugin.copilot!.createSession(this.buildBasicSearchSessionConfig());
		}

		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();

		let searchPrompt: string;
		let attachments: NonNullable<MessageOptions['attachments']> | undefined;

		if (candidates.length > 0) {
			// Phase 2: Build compact summaries for LLM re-ranking
			const summaries = candidates.map(c => ({
				file: c.note.path,
				folder: c.note.folder,
				tags: c.note.tags.slice(0, 5),
				headings: c.note.headings.slice(0, 5),
				matchReasons: c.matchReasons,
				score: c.score,
			}));

			searchPrompt = [
				'Re-rank these search candidates by relevance to the query.',
				'Return ONLY a JSON array of objects with "file", "folder", and "reason".',
				'Sort by relevance (best first). No markdown fences, no extra text.',
				'',
				`Query: ${query}`,
				'',
				'Candidates:',
				JSON.stringify(summaries, null, 2),
			].join('\n');
			attachments = undefined; // No directory attachment — candidates already narrowed
		} else {
			// No metadata matches — fall back to full LLM search
			searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.\n\nQuery: ${query}`;
			attachments = [{type: 'directory', path: scopePath, displayName: scopeLabel}];
		}

		try {
			const timeout = candidates.length > 0 ? 30_000 : 120_000;
			const response = await this.basicSearchSession.sendAndWait({
				prompt: searchPrompt,
				attachments,
			}, timeout);
			const content = response?.data.content || '';
			this.addToSearchCache(cacheKey, {content, cachedAt: Date.now(), scopePaths: [scopePath], mode: 'basic'});
			this.renderSearchResults(content);
		} catch (e) {
			// Session may be broken — discard and rethrow so outer catch handles it
			try { await this.basicSearchSession.disconnect(); } catch { /* ignore */ }
			this.basicSearchSession = null;
			throw e;
		}
	}

	async handleAdvancedSearch(query: string): Promise<void> {
		// Check cache first
		const scopePath = this.getSearchWorkingDirectory();
		const agentKey = this.searchAgent || undefined;
		const cacheKey = this.buildSearchCacheKey(query, 'advanced', [scopePath], agentKey);
		const cached = this.searchCache.get(cacheKey);
		if (cached && Date.now() - cached.cachedAt < SidekickView.SEARCH_CACHE_TTL) {
			this.renderSearchResults(cached.content, true);
			return;
		}

		const sessionConfig = this.buildSearchSessionConfig();
		this.searchSession = await this.plugin.copilot!.createSession(sessionConfig);
		const sessionId = this.searchSession.sessionId;

		// Name the session
		const agentLabel = this.searchAgent || 'Search';
		const truncated = query.length > 40 ? query.slice(0, 40) + '…' : query;
		this.sessionNames[sessionId] = `[search] ${agentLabel}: ${truncated}`;
		this.saveSessionNames();

		// Add to session list
		if (!this.sessionList.some(s => s.sessionId === sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as SessionMetadata);
		}
		this.renderSessionList();

		// Pre-filter hints for the LLM
		const preFilterCandidates = this.vaultIndex?.preFilter(query, [this.searchWorkingDir || '/'], 15) ?? [];
		const hint = preFilterCandidates.length > 0
			? `\n\nLocal pre-filter found ${preFilterCandidates.length} likely matches:\n` +
				preFilterCandidates.map(c => `- ${c.note.path} (${c.matchReasons.join(', ')})`).join('\n') +
				'\n\nUse these as starting points, but search beyond them if needed.'
			: '';

		const searchPrompt = `Perform a semantic search for files matching the following query. Return ONLY a JSON array of objects, each with "file" (vault-relative path), "folder" (parent folder path), and "reason" (brief description why it matches). Sort by relevance (best match first). No markdown fences, no extra text.${hint}\n\nQuery: ${query}`;

		const scopeLabel = this.searchWorkingDir || this.app.vault.getName();
		try {
			const response = await this.searchSession.sendAndWait({
				prompt: searchPrompt,
				attachments: [{type: 'directory', path: scopePath, displayName: scopeLabel}],
			}, 120_000);
			const content = response?.data.content || '';
			this.addToSearchCache(cacheKey, {content, cachedAt: Date.now(), scopePaths: [scopePath], mode: 'advanced', agent: agentKey});
			this.renderSearchResults(content);
		} finally {
			if (this.searchSession) {
				try { await this.searchSession.disconnect(); } catch { /* ignore */ }
				this.searchSession = null;
			}
		}
	}

	/** Minimal session config for basic search — no MCP servers, skills, or custom agents. */
	buildBasicSearchSessionConfig(): SessionConfig {
		const permissionHandler = (request: PermissionRequest) => {
			if (this.plugin.settings.toolApproval === 'allow') {
				return approveAll(request, {sessionId: ''});
			}
			const modal = new ToolApprovalModal(this.app, request);
			modal.open();
			return modal.promise;
		};

		// Use inline model setting, fall back to first available model
		let model = this.plugin.settings.inlineModel || undefined;
		if (!model && this.models.length > 0 && this.models[0]) {
			model = this.models[0].id;
		}

		// BYOK provider
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai', azure: 'azure', anthropic: 'anthropic',
				ollama: 'openai', 'foundry-local': 'openai', 'other-openai': 'openai',
			};
			provider = {
				type: typeMap[providerPreset] ?? 'openai',
				baseUrl: this.plugin.settings.providerBaseUrl,
				...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
				...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
				wireApi: this.plugin.settings.providerWireApi,
			};
		}

		return {
			model: (provider && this.plugin.settings.providerModel) ? this.plugin.settings.providerModel : model,
			streaming: providerPreset !== 'foundry-local',
			onPermissionRequest: permissionHandler,
			workingDirectory: this.getSearchWorkingDirectory(),
			...(provider ? {provider} : {}),
		};
	}

	renderSearchResults(content: string, fromCache = false): void {
		this.searchResultsEl.empty();

		if (fromCache) {
			this.searchResultsEl.createDiv({cls: 'sidekick-search-cached', text: 'Cached results'});
		}

		// Try to parse JSON array from the response
		let results: Array<{file?: string; path?: string; folder: string; reason: string}> = [];
		try {
			// Strip markdown fences if present
			const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
			const parsed = JSON.parse(cleaned);
			// Handle both single object and array responses
			results = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			// If not valid JSON, show the raw response
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: content || 'No results found.'});
			return;
		}

		if (!Array.isArray(results) || results.length === 0) {
			this.searchResultsEl.createDiv({cls: 'sidekick-search-empty', text: 'No results found.'});
			return;
		}

		for (const result of results) {
			const item = this.searchResultsEl.createDiv({cls: 'sidekick-search-result'});

			const fileRow = item.createDiv({cls: 'sidekick-search-result-file'});
			const fileIcon = fileRow.createSpan({cls: 'sidekick-search-result-icon'});
			setIcon(fileIcon, 'file-text');
			const filePath = (result.file || result.path || '').replace(/^\/+/, '');
			const fileName = filePath.split('/').pop() || filePath || 'Unknown';
			const fileLink = fileRow.createSpan({cls: 'sidekick-search-result-name', text: fileName});

			fileLink.addEventListener('click', () => {
				if (!filePath) return;
				const resolved = this.app.vault.getAbstractFileByPath(filePath)
					?? (result.folder ? this.app.vault.getAbstractFileByPath(result.folder + '/' + filePath) : null);
				if (resolved instanceof TFile) {
					void this.app.workspace.openLinkText(resolved.path, '', false);
				} else {
					// Fallback: let Obsidian try to resolve the link
					void this.app.workspace.openLinkText(filePath, '', false);
				}
			});

			if (result.folder) {
				fileRow.createSpan({cls: 'sidekick-search-result-folder', text: result.folder});
			}

			if (result.reason) {
				item.createDiv({cls: 'sidekick-search-result-reason', text: result.reason});
			}
		}
	}

	// ── Search cache helpers ─────────────────────────────────────

	buildSearchCacheKey(query: string, mode: 'basic' | 'advanced', scopePaths: string[], agent?: string): string {
		const normalized = [
			query.trim().toLowerCase(),
			mode,
			[...scopePaths].sort().join('|'),
			agent ?? '',
		].join('\0');
		let hash = 0;
		for (let i = 0; i < normalized.length; i++) {
			hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
		}
		return hash.toString(36);
	}

	addToSearchCache(key: string, entry: {content: string; cachedAt: number; scopePaths: string[]; mode: 'basic' | 'advanced'; agent?: string}): void {
		if (this.searchCache.size >= SidekickView.SEARCH_CACHE_MAX) {
			let oldestKey = '';
			let oldestTime = Infinity;
			for (const [k, v] of this.searchCache) {
				if (v.cachedAt < oldestTime) {
					oldestTime = v.cachedAt;
					oldestKey = k;
				}
			}
			if (oldestKey) this.searchCache.delete(oldestKey);
		}
		this.searchCache.set(key, entry);
	}

	invalidateSearchCache(): void {
		if (this.searchCache.size > 0) {
			this.searchCache.clear();
		}
	}

	updateSearchButton(): void {
		this.searchBtnEl.empty();
		if (this.isSearching) {
			setIcon(this.searchBtnEl, 'square');
			this.searchBtnEl.title = 'Cancel search';
			this.searchBtnEl.addClass('is-searching');
		} else {
			setIcon(this.searchBtnEl, 'search');
			this.searchBtnEl.title = 'Search';
			this.searchBtnEl.removeClass('is-searching');
		}
	}

	// ── Subagent blocks ──────────────────────────────────────────

	addSubagentBlock(toolCallId: string, agentName: string, _status: string, description?: string): void {
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

		this.activeSubagentBlocks.set(toolCallId, block);
		this.scrollToBottom();
	}

	updateSubagentBlock(toolCallId: string, status: 'completed' | 'failed', error?: string): void {
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
	}

	// ── Send & abort ─────────────────────────────────────────────

	async handleSend(): Promise<void> {
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
			const isBuiltin = SidekickView.BUILTIN_COMMANDS.some(c => c.name === cmdName);
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

		// Prepend prompt template content if active
		const sendPrompt = usedPrompt ? `${usedPrompt.content}\n\n${prompt}` : prompt;

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
			await this.ensureSession();

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
					await this.ensureSession();
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
	}

	async handleAbort(): Promise<void> {
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
	}

	// ── Session management ───────────────────────────────────────

	async ensureSession(): Promise<void> {
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
		const sessionConfig = this.buildSessionConfig({
			model: this.resolveModelForAgent(agent, this.selectedModel || undefined),
			selectedAgentName: effectiveAgentName || undefined,
		});

		this.currentSession = await this.plugin.copilot!.createSession(sessionConfig);
		this.currentSessionId = this.currentSession.sessionId;
		this.configDirty = false;
		this.sessionContextPaths.clear();
		this.registerSessionEvents();
		this.updateToolbarLock();

		// Add new session to list immediately so sidebar updates instantly
		if (!this.sessionList.some(s => s.sessionId === this.currentSession!.sessionId)) {
			const now = new Date();
			this.sessionList.unshift({
				sessionId: this.currentSession.sessionId,
				startTime: now,
				modifiedTime: now,
				isRemote: false,
			} as import('./copilot').SessionMetadata);
		}
		this.renderSessionList();
	}

	registerSessionEvents(): void {
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
				this.addToolCallBlock(event.data.toolCallId, event.data.toolName, event.data.arguments);
			}),
			session.on('tool.execution_complete', (event) => {
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
				this.addSubagentBlock(event.data.toolCallId, event.data.agentDisplayName || event.data.agentName, 'started', event.data.agentDescription);
			}),
			session.on('subagent.completed', (event) => {
				this.updateSubagentBlock(event.data.toolCallId, 'completed');
			}),
			session.on('subagent.failed', (event) => {
				this.updateSubagentBlock(event.data.toolCallId, 'failed', event.data.error);
			}),
			session.on('session.info', (event) => {
				this.handleMcpSessionEvent(event.data.infoType, event.data.message, 'info');
			}),
			session.on('session.warning', (event) => {
				this.handleMcpSessionEvent(event.data.warningType, event.data.message, 'warning');
			}),
		);
	}

	unsubscribeEvents(): void {
		for (const unsub of this.eventUnsubscribers) unsub();
		this.eventUnsubscribers = [];
	}

	async disconnectSession(): Promise<void> {
		this.unsubscribeEvents();
		if (this.currentSession) {
			try {
				await this.currentSession.disconnect();
			} catch { /* ignore */ }
			this.currentSession = null;
		}
	}

	async disconnectAllSessions(): Promise<void> {
		await this.disconnectSession();
		for (const [, bg] of this.activeSessions) {
			for (const unsub of bg.unsubscribers) unsub();
			try { await bg.session.disconnect(); } catch { /* ignore */ }
			if (bg.streamingComponent) {
				try { this.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
		}
		this.activeSessions.clear();
	}

	newConversation(): void {
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
		this.inputEl.removeAttribute('title');
		this.chatContainer.empty();
		this.renderWelcome();
		this.renderAttachments();
		this.rebuildSuggestions(false);
		this.renderActiveNoteBar();
		this.renderScopeBar();
		this.updateSendButton();
		this.updateToolbarLock();
		this.renderSessionList();
	}

	// ── Session config building ──────────────────────────────────

	buildSessionConfig(opts: {
		model?: string;
		systemContent?: string;
		selectedAgentName?: string;
	}): SessionConfig {
		// Resolve agent instructions into systemContent when an agent is selected
		let systemContent = opts.systemContent;
		if (!systemContent && opts.selectedAgentName) {
			const agent = this.agents.find(a => a.name === opts.selectedAgentName);
			if (agent?.instructions) {
				systemContent = agent.instructions;
			}
		}

		// MCP servers
		const mcpServers: Record<string, MCPServerConfig> = {};
		for (const server of this.mcpServers) {
			if (!this.enabledMcpServers.has(server.name)) continue;
			const cfg = server.config;
			const serverType = cfg['type'] as string | undefined;
			const tools = (cfg['tools'] as string[] | undefined) ?? ['*'];

			if (serverType === 'http' || serverType === 'sse') {
				mcpServers[server.name] = {
					type: serverType,
					url: cfg['url'] as string,
					tools,
					...(cfg['headers'] ? {headers: cfg['headers'] as Record<string, string>} : {}),
					...(cfg['timeout'] != null ? {timeout: cfg['timeout'] as number} : {}),
				} as MCPServerConfig;
			} else if (cfg['command']) {
				mcpServers[server.name] = {
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

		// Skills
		const basePath = this.getVaultBasePath();
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		// Custom agents — always pass all agents so the model can delegate via subagent.
		// When a specific agent is selected, its system message is applied via systemContent
		// but other agents remain available as subagents for delegation.
		// The agent tools field can contain MCP server names AND/OR other agent names.
		// MCP names scope mcpServers; agent names enable sub-agent delegation via prompt.
		const agentNameSet = new Set(this.agents.map(ag => ag.name));
		const customAgents: CustomAgentConfig[] = this.agents.map(a => {
			let agentMcpServers: Record<string, MCPServerConfig> | undefined;
			if (a.tools !== undefined && a.tools.length > 0) {
				const scoped: Record<string, MCPServerConfig> = {};
				for (const entry of a.tools) {
					if (!agentNameSet.has(entry) && mcpServers[entry]) {
						scoped[entry] = mcpServers[entry];
					}
				}
				if (Object.keys(scoped).length > 0) agentMcpServers = scoped;
			}
			// Build prompt: include available sub-agent roster (filtered by handoffs if specified).
			let prompt = a.instructions;
			const subAgents = this.agents.filter(ag => {
				if (ag.name === a.name) return false;
				if (a.handoffs !== undefined) return a.handoffs.some(h => h.agent === ag.name);
				return true;
			});
			if (subAgents.length > 0) {
				const agentDescs = subAgents.map(ag => {
					const handoff = a.handoffs?.find(h => h.agent === ag.name);
					const base = ag.description ? `- **${ag.name}**: ${ag.description}` : `- **${ag.name}**`;
					return handoff?.prompt ? `${base}\n  Handoff instructions: ${handoff.prompt}` : base;
				}).join('\n');
				prompt += `\n\nYou can delegate tasks to the following sub-agents by invoking them as tools:\n${agentDescs}`;
			}
			return {
				name: a.name,
				displayName: a.name,
				description: a.description || undefined,
				prompt,
				// tools: null = all tool names; [] = no tools
				tools: (a.tools !== undefined && a.tools.length === 0) ? [] : null,
				...(agentMcpServers ? {mcpServers: agentMcpServers} : {}),
				infer: true,
			};
		});

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

		// Build BYOK provider config if a non-GitHub preset is selected
		const providerPreset = this.plugin.settings.providerPreset;
		let provider: ProviderConfig | undefined;
		if (providerPreset !== 'github' && this.plugin.settings.providerBaseUrl) {
			const typeMap: Record<string, 'openai' | 'azure' | 'anthropic'> = {
				openai: 'openai',
				azure: 'azure',
				anthropic: 'anthropic',
				ollama: 'openai',
				'foundry-local': 'openai',
				'other-openai': 'openai',
			};
			provider = {
				type: typeMap[providerPreset] ?? 'openai',
				baseUrl: this.plugin.settings.providerBaseUrl,
				...(this.plugin.settings.providerApiKey ? {apiKey: this.plugin.settings.providerApiKey} : {}),
				...(this.plugin.settings.providerBearerToken ? {bearerToken: this.plugin.settings.providerBearerToken} : {}),
				wireApi: this.plugin.settings.providerWireApi,
			};
		}

		const reasoningEffort = this.plugin.settings.reasoningEffort;

		// Build system message: global instructions + agent instructions + MCP tool guidance
		const mcpServerNames = Object.keys(mcpServers);
		const systemParts: string[] = [];
		if (this.globalInstructions) {
			systemParts.push(this.globalInstructions);
		}
		if (systemContent) {
			systemParts.push(systemContent);
		}
		if (mcpServerNames.length > 0) {
			systemParts.push(
				'You have access to MCP tool servers: ' + mcpServerNames.join(', ') + '.\n' +
				'Prefer using MCP tools over shell commands or direct file reads when the MCP servers provide equivalent functionality. ' +
				'Only fall back to shell commands when no MCP tool can accomplish the task.'
			);
		}
		if (this.plugin.settings.contextMode === 'suggest') {
			systemParts.push('Use on-demand file/search tools to gather vault context when needed instead of assuming local context is pre-attached.');
		}
		const finalSystemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

		debugTrace('buildSessionConfig', {
			mcpServerCount: mcpServerNames.length,
			mcpServerNames,
			customAgentCount: customAgents.length,
			skillDirCount: skillDirs.length,
			hasSystemMessage: !!finalSystemContent,
			selectedAgent: opts.selectedAgentName,
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
			...(finalSystemContent ? {systemMessage: {mode: 'append' as const, content: finalSystemContent}} : {}),
		};
	}

	async triageRequest(prompt: string): Promise<string | null> {
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
	}

	/**
	 * Return the current skill/MCP/workingDirectory config for external callers
	 * (e.g. editorMenu inline sessions) so they can pass it to createSession.
	 */
	getSessionExtras(): {
		skillDirectories?: string[];
		disabledSkills?: string[];
		mcpServers?: Record<string, MCPServerConfig>;
		workingDirectory?: string;
	} {
		const basePath = this.getVaultBasePath();

		// Skills
		const skillDirs: string[] = [];
		if (this.skills.length > 0) {
			skillDirs.push([basePath, getSkillsFolder(this.plugin.settings)].join('/'));
		}
		const disabledSkills = this.skills
			.filter(s => !this.enabledSkills.has(s.name))
			.map(s => s.name);

		// MCP servers
		const mcpServers = mapMcpServers(this.mcpServers, this.enabledMcpServers);

		return {
			...(skillDirs.length > 0 ? {skillDirectories: skillDirs} : {}),
			...(disabledSkills.length > 0 ? {disabledSkills} : {}),
			...(Object.keys(mcpServers).length > 0 ? {mcpServers} : {}),
			workingDirectory: this.getWorkingDirectory(),
		};
	}

	// ── Utilities ────────────────────────────────────────────────

	getWorkingDirectory(): string {
		const base = this.getVaultBasePath();
		if (!this.workingDir) return base;
		return base + '/' + normalizePath(this.workingDir);
	}

	getAgentsFolder(): string {
		return getAgentsFolder(this.plugin.settings);
	}

	getVaultBasePath(): string {
		return (this.app.vault.adapter as unknown as {basePath: string}).basePath;
	}

	scrollToBottom(): void {
		// Only auto-scroll if user is near the bottom.
		// Scroll immediately (no extra rAF) since callers are already in
		// rAF or post-render context — an extra frame delay during streaming
		// causes the threshold check to desync and lose auto-scroll.
		const threshold = 200;
		const el = this.chatContainer;
		const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
		if (isNear) {
			el.scrollTop = el.scrollHeight;
		}
	}

	forceScrollToBottom(): void {
		// Double rAF ensures layout is complete after markdown rendering
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			});
		});
	}
}

// ── Install feature modules ─────────────────────────────────────
// These extend SidekickView.prototype with methods organized by feature area.
import {installChatRenderer} from './view/chatRenderer';
import {installSearchPanel} from './view/searchPanel';
import {installTriggersPanel} from './view/triggersPanel';
import {installSessionSidebar} from './view/sessionSidebar';
import {installInputArea} from './view/inputArea';
import {installConfigToolbar} from './view/configToolbar';
import {buildPrompt} from './view/sessionConfig';
import {buildSdkAttachments} from './view/sessionConfig';

installChatRenderer(SidekickView);
installSearchPanel(SidekickView);
installTriggersPanel(SidekickView);
installSessionSidebar(SidekickView);
installInputArea(SidekickView);
installConfigToolbar(SidekickView);
