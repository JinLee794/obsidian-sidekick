import {App, Notice, PluginSettingTab, Setting, normalizePath} from "obsidian";
import SidekickPlugin from "./main";
import type {ModelInfo} from "./copilot";

const DEFAULT_COPILOT_LOCATION = '';

export interface SidekickSettings {
	/** 'local' uses cliPath, 'remote' uses cliUrl. */
	copilotType: 'local' | 'remote';
	copilotLocation: string;
	/** URL of an existing CLI server to connect to. */
	cliUrl: string;
	/** Use the logged-in GitHub user for auth (local mode). */
	useLoggedInUser: boolean;
	/** GitHub personal access token (used when useLoggedInUser is false or in remote mode). */
	githubToken: string;
	sidekickFolder: string;
	toolApproval: 'ask' | 'allow';
	/** Model ID used for inline editor operations (context menu). Empty = SDK default. */
	inlineModel: string;
	/** Enable ghost-text autocomplete in the editor. */
	autocompleteEnabled: boolean;
	/** Custom display names for sessions, keyed by SDK sessionId. */
	sessionNames?: Record<string, string>;
	/** Last-fired timestamps for trigger deduplication, keyed by trigger name. */
	triggerLastFired?: Record<string, number>;
}

export const DEFAULT_SETTINGS: SidekickSettings = {
	copilotType: 'local',
	copilotLocation: DEFAULT_COPILOT_LOCATION,
	cliUrl: '',
	useLoggedInUser: true,
	githubToken: '',
	sidekickFolder: 'sidekick',
	toolApproval: 'ask',
	inlineModel: '',
	autocompleteEnabled: false,
}

/** Derive the agents subfolder from the base Sidekick folder. */
export function getAgentsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/agents`);
}

/** Derive the skills subfolder from the base Sidekick folder. */
export function getSkillsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/skills`);
}

/** Derive the tools subfolder from the base Sidekick folder. */
export function getToolsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/tools`);
}

/** Derive the prompts subfolder from the base Sidekick folder. */
export function getPromptsFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/prompts`);
}

/** Derive the triggers subfolder from the base Sidekick folder. */
export function getTriggersFolder(settings: SidekickSettings): string {
	return normalizePath(`${settings.sidekickFolder}/triggers`);
}

const SAMPLE_SKILL_CONTENT = `---
name: ascii-art
description: Generates stylized ASCII art text using block characters
---

# ASCII Art Generator

This skill generates ASCII art representations of text using block-style Unicode characters.

## Usage

When a user requests ASCII art for any word or phrase, generate the block-style representation immediately without asking for clarification on style preferences.
`;

const SAMPLE_AGENT_CONTENT = `---
name: Grammar
description: The Grammar Assistant agent helps users improve their writing
tools:
  - github
skills:
  - ascii-art
model: Claude Sonnet 4.5
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** - the primary task is to helps users improve their writing
`;

const SAMPLE_PROMPT_CONTENT = `---
agent: Grammar
---
Translate the provided text from English to Portuguese.
`;

const SAMPLE_TRIGGER_CONTENT = `---
description: Daily planner
agent: Planner
triggers:
  - type: scheduler 
    cron: "0 8 * * *"
  - type: onFileChange
    glob: "**/*.md"
enabled: true
---
Help me prepare my day, including asks on me, recommendations for clear actions to prepare, and suggestions on which items to prioritize over others.
`;

export class SidekickSettingTab extends PluginSettingTab {
	plugin: SidekickPlugin;

	constructor(app: App, plugin: SidekickPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// Hoisted so the Test button and Models section can both reference it
		let refreshModels: () => Promise<void> = async () => {};

		// ── GitHub Copilot Client section ────────────────────────
		// Heading row with Type dropdown + Test button
		const clientFieldsEl = containerEl.createDiv();

		const renderClientFields = () => {
			clientFieldsEl.empty();
			const isRemote = this.plugin.settings.copilotType === 'remote';

			if (isRemote) {
				new Setting(clientFieldsEl)
					.setName('URL')
					.setDesc('URL of existing CLI server to connect to.')
					.addText(text => text
						.setPlaceholder('e.g. localhost:8080')
						.setValue(this.plugin.settings.cliUrl)
						.onChange(async (value) => {
							this.plugin.settings.cliUrl = value.trim();
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
						}));

				new Setting(clientFieldsEl)
					.setName('GitHub Token')
					.setDesc('GitHub token for authentication.')
					.addText(text => {
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.setPlaceholder('ghp_…')
							.setValue(this.plugin.settings.githubToken)
							.onChange(async (value) => {
								this.plugin.settings.githubToken = value.trim();
								await this.plugin.saveSettings();
								await this.plugin.initCopilot();
							});
					});
			} else {
				new Setting(clientFieldsEl)
					.setName('Path')
					.setDesc('Path to CLI executable (default: "copilot" from PATH).')
					.addText(text => text
						.setPlaceholder('Leave blank for default')
						.setValue(this.plugin.settings.copilotLocation)
						.onChange(async (value) => {
							const sanitized = value.trim();
							if (/[;|&`$(){}]/.test(sanitized)) {
								new Notice('Copilot location contains invalid characters.');
								return;
							}
							this.plugin.settings.copilotLocation = sanitized;
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
						}));

				new Setting(clientFieldsEl)
					.setName('Use Logged\u2011in User')
					.setDesc('Whether to use logged-in user for authentication.')
					.addToggle(toggle => toggle
						.setValue(this.plugin.settings.useLoggedInUser)
						.onChange(async (value) => {
							this.plugin.settings.useLoggedInUser = value;
							await this.plugin.saveSettings();
							await this.plugin.initCopilot();
							renderClientFields();
						}));

				if (!this.plugin.settings.useLoggedInUser) {
					new Setting(clientFieldsEl)
						.setName('GitHub Token')
						.setDesc('GitHub token for authentication.')
						.addText(text => {
							text.inputEl.type = 'password';
							text.inputEl.autocomplete = 'off';
							text.setPlaceholder('ghp_…')
								.setValue(this.plugin.settings.githubToken)
								.onChange(async (value) => {
									this.plugin.settings.githubToken = value.trim();
									await this.plugin.saveSettings();
									await this.plugin.initCopilot();
								});
						});
				}
			}
		};

		new Setting(containerEl)
			.setName('GitHub Copilot Client')
			.setHeading()
			.addDropdown(dropdown => dropdown
				.addOptions({local: 'Local CLI', remote: 'Remote CLI'})
				.setValue(this.plugin.settings.copilotType)
				.onChange(async (value) => {
					this.plugin.settings.copilotType = value as 'local' | 'remote';
					await this.plugin.saveSettings();
					await this.plugin.initCopilot();
					renderClientFields();
				}))
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const result = await this.plugin.copilot.ping();
						new Notice(`Copilot connected: ${result.message}`);
						await refreshModels();
					} catch (e) {
						new Notice(`Test failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		containerEl.appendChild(clientFieldsEl);
		renderClientFields();

		new Setting(containerEl)
			.setName('Sidekick folder')
			.setDesc('Vault folder for agents, skills, tools and triggers.')
			.addText(text => text
				.setPlaceholder('e.g. sidekick')
				.setValue(this.plugin.settings.sidekickFolder)
				.onChange(async (value) => {
					const sanitized = value.trim().replace(/\.\./g, '');
					if (!sanitized || /[;|&`$(){}]/.test(sanitized)) {
						new Notice('Sidekick folder name is invalid.');
						return;
					}
					this.plugin.settings.sidekickFolder = sanitized;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const base = normalizePath(this.plugin.settings.sidekickFolder);
						const adapter = this.app.vault.adapter;

						// Create base folder and subfolders
						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/tools', '/prompts', '/triggers']) {
							const dir = normalizePath(`${base}${sub}`);
							if (!(await adapter.exists(dir))) {
								await this.app.vault.createFolder(dir);
							}
						}

						// Sample agent
						const agentPath = normalizePath(`${base}/agents/grammar.agent.md`);
						if (!(await adapter.exists(agentPath))) {
							await this.app.vault.create(agentPath, SAMPLE_AGENT_CONTENT);
						}

						// Sample skill
						const skillPath = normalizePath(`${base}/skills/ascii-art/SKILL.md`);
						if (!(await adapter.exists(skillPath))) {
							await this.app.vault.create(skillPath, SAMPLE_SKILL_CONTENT);
						}

						// Sample mcp.json
						const mcpPath = normalizePath(`${base}/tools/mcp.json`);
						if (!(await adapter.exists(mcpPath))) {
							const mcpContent = JSON.stringify({
								servers: {
									github: {
										type: 'http',
										url: 'https://api.githubcopilot.com/mcp/'
									}
								}
							}, null, '\t');
							await this.app.vault.create(mcpPath, mcpContent);
						}

						// Sample prompt
						const promptPath = normalizePath(`${base}/prompts/en-to-pt.prompt.md`);
						if (!(await adapter.exists(promptPath))) {
							await this.app.vault.create(promptPath, SAMPLE_PROMPT_CONTENT);
						}

						// Sample trigger
						const triggerPath = normalizePath(`${base}/triggers/daily-planner.trigger.md`);
						if (!(await adapter.exists(triggerPath))) {
							await this.app.vault.create(triggerPath, SAMPLE_TRIGGER_CONTENT);
						}

						new Notice('Sidekick folder initialized with sample agent, skill, prompt, trigger, and mcp.json.');
					} catch (e) {
						new Notice(`Failed to initialize Sidekick folder: ${String(e)}`);
					}
				}));

		new Setting(containerEl)
			.setName('Tools approval')
			.setDesc('Whether tool invocations require manual approval or are allowed automatically.')
			.addDropdown(dropdown => dropdown
				.addOptions({allow: 'Allow (auto-approve)', ask: 'Ask (require approval)'})
				.setValue(this.plugin.settings.toolApproval)
				.onChange(async (value) => {
					this.plugin.settings.toolApproval = value as 'ask' | 'allow';
					await this.plugin.saveSettings();
				}));

		// --- Models section ---
		new Setting(containerEl).setName('Models').setHeading();

		let inlineModelSelect: HTMLSelectElement | null = null;

		const populateInlineDropdown = (models: ModelInfo[]) => {
			if (inlineModelSelect) {
				inlineModelSelect.empty();
				inlineModelSelect.createEl('option', {text: 'Default (SDK default)', value: ''});
				for (const model of models) {
					inlineModelSelect.createEl('option', {
						text: model.name,
						value: model.id,
					});
				}
				if (this.plugin.settings.inlineModel) {
					inlineModelSelect.value = this.plugin.settings.inlineModel;
				}
			}
		};

		refreshModels = async () => {
			try {
				if (!this.plugin.copilot) return;
				const models: ModelInfo[] = await this.plugin.copilot.listModels();
				populateInlineDropdown(models);
			} catch {
				// silently ignore — dropdown keeps its placeholder
			}
		};

		new Setting(containerEl)
			.setName('Inline operations model')
			.setDesc('Model used for editor context-menu actions (fix grammar, summarize, etc.).')
			.addDropdown(dropdown => {
				inlineModelSelect = dropdown.selectEl;
				dropdown.addOption('', 'Default (SDK default)');
				if (this.plugin.settings.inlineModel) {
					dropdown.addOption(this.plugin.settings.inlineModel, this.plugin.settings.inlineModel);
					dropdown.setValue(this.plugin.settings.inlineModel);
				}
				dropdown.onChange(async (value) => {
					this.plugin.settings.inlineModel = value;
					await this.plugin.saveSettings();
				});
			});

		// --- Autocomplete section ---
		new Setting(containerEl).setName('Autocomplete').setHeading();

		new Setting(containerEl)
			.setName('Enable ghost-text autocomplete')
			.setDesc('Show inline suggestions as you type (uses the inline operations model).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autocompleteEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autocompleteEnabled = value;
					await this.plugin.saveSettings();
				}));

		// Auto-refresh models when opening settings
		void refreshModels();
	}
}
