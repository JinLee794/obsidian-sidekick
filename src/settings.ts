import {App, Notice, PluginSettingTab, Setting, normalizePath} from "obsidian";
import SidekickPlugin from "./main";
import type {ModelInfo} from "./copilot";

const DEFAULT_COPILOT_LOCATION = '';

export interface SidekickSettings {
	copilotLocation: string;
	sidekickFolder: string;
	toolApproval: 'ask' | 'allow';
}

export const DEFAULT_SETTINGS: SidekickSettings = {
	copilotLocation: DEFAULT_COPILOT_LOCATION,
	sidekickFolder: 'sidekick',
	toolApproval: 'allow',
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
model: Claude Sonnet 4.5
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** - the primary task is to helps users improve their writing
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

		new Setting(containerEl)
			.setName('Copilot location')
			.setDesc('Path to the Copilot CLI')
			.addText(text => text
				.setPlaceholder('e.g. /usr/local/bin/copilot')
				.setValue(this.plugin.settings.copilotLocation)
				.onChange(async (value) => {
					this.plugin.settings.copilotLocation = value.trim();
					await this.plugin.saveSettings();
					await this.plugin.initCopilot();
				}))
			.addButton(button => button
				.setButtonText('Ping')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Pinging…');
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const result = await this.plugin.copilot.ping();
						new Notice(`Copilot connected: ${result.message}`);
					} catch (e) {
						new Notice(`Ping failed: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Ping');
					}
				}));

		new Setting(containerEl)
			.setName('Sidekick folder')
			.setDesc('Vault folder for agents, skills, and tools.')
			.addText(text => text
				.setPlaceholder('e.g. sidekick')
				.setValue(this.plugin.settings.sidekickFolder)
				.onChange(async (value) => {
					this.plugin.settings.sidekickFolder = value;
					await this.plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Initialize')
				.onClick(async () => {
					try {
						const base = normalizePath(this.plugin.settings.sidekickFolder);
						const adapter = this.app.vault.adapter;

						// Create base folder and subfolders
						for (const sub of ['', '/agents', '/skills', '/skills/ascii-art', '/tools']) {
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

						new Notice('Sidekick folder initialized with sample agent, skill, and mcp.json.');
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

		const modelsContainer = containerEl.createDiv({cls: 'sidekick-models-list'});

		new Setting(containerEl)
			.setName('Available models')
			.setDesc('Fetch available models from Copilot')
			.addButton(button => button
				.setButtonText('List')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Loading…');
					modelsContainer.empty();
					try {
						if (!this.plugin.copilot) {
							throw new Error('Copilot service is not available');
						}
						const models: ModelInfo[] = await this.plugin.copilot.listModels();
						this.renderModels(modelsContainer, models);
						new Notice(`Loaded ${models.length} model(s).`);
					} catch (e) {
						modelsContainer.createEl('p', {
							text: `Error: ${String(e)}`,
							cls: 'sidekick-models-error'
						});
						new Notice(`Failed to load models: ${String(e)}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('List');
					}
				}));
	}

	private renderModels(container: HTMLElement, models: ModelInfo[]): void {
		if (models.length === 0) {
			container.createEl('p', {text: 'No models available.'});
			return;
		}

		const list = container.createEl('ul', {cls: 'sidekick-models-ul'});
		for (const model of models) {
			const item = list.createEl('li');
			item.createEl('strong', {text: model.name});
			item.createSpan({text: ` (${model.id})`});
		}
	}
}
