import {App, Modal, Notice, TFile, normalizePath, setIcon} from 'obsidian';
import {probeMcpServer, enrichServersWithAzureAuth} from '../mcpProbe';
import type {McpServerEntry} from '../types';

/**
 * Modal to view/edit the mcp.json configuration file directly from the tools view.
 * Provides live JSON validation with per-server structure checks and test buttons.
 */
export class McpEditorModal extends Modal {
	private readonly mcpPath: string;
	private textArea!: HTMLTextAreaElement;
	private errorEl!: HTMLElement;
	private serversEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private onSaved: () => void;

	constructor(app: App, toolsFolder: string, onSaved: () => void) {
		super(app);
		this.mcpPath = normalizePath(`${toolsFolder}/mcp.json`);
		this.onSaved = onSaved;
	}

	async onOpen(): Promise<void> {
		const {contentEl, modalEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-mcp-editor-modal');
		// Ensure the modal wrapper also uses the wider sizing
		modalEl.addClass('sidekick-mcp-editor-modal-wrapper');

		contentEl.createEl('h3', {text: 'Edit mcp.json'});

		const pathHint = contentEl.createDiv({cls: 'sidekick-mcp-editor-path'});
		pathHint.setText(this.mcpPath);

		// Load existing content
		let content = '';
		const file = this.app.vault.getAbstractFileByPath(this.mcpPath);
		if (file && file instanceof TFile) {
			content = await this.app.vault.read(file);
		} else {
			content = JSON.stringify({servers: {}}, null, '\t');
		}

		this.textArea = contentEl.createEl('textarea', {
			cls: 'sidekick-mcp-editor-textarea',
		});
		this.textArea.value = content;
		this.textArea.spellcheck = false;
		this.textArea.addEventListener('input', () => this.validate());

		// Error message area
		this.errorEl = contentEl.createDiv({cls: 'sidekick-mcp-editor-error'});

		// Per-server validation & test section
		this.serversEl = contentEl.createDiv({cls: 'sidekick-mcp-editor-servers'});

		// Button row
		const btnRow = contentEl.createDiv({cls: 'sidekick-mcp-editor-buttons'});

		const testAllBtn = btnRow.createEl('button', {text: 'Test all'});
		const testIcon = testAllBtn.createSpan();
		setIcon(testIcon, 'play');
		testAllBtn.prepend(testIcon);
		testAllBtn.addEventListener('click', () => void this.testAllServers());

		const spacer = btnRow.createDiv({cls: 'sidekick-mcp-editor-spacer'});
		spacer.style.flex = '1';

		this.saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		this.saveBtn.addEventListener('click', () => void this.save());

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());

		// Run initial validation
		this.validate();
	}

	/** Validate JSON, check server structure, and render per-server status. */
	private validate(): boolean {
		const text = this.textArea.value.trim();
		this.errorEl.empty();
		this.serversEl.empty();
		this.textArea.removeClass('is-invalid');

		if (!text) {
			this.saveBtn.disabled = false;
			return true;
		}

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				this.showError('JSON must be an object (e.g. { "servers": { ... } })');
				return false;
			}
		} catch (e) {
			const msg = e instanceof SyntaxError ? e.message : String(e);
			this.showError(`Invalid JSON: ${msg}`);
			return false;
		}

		const serversObj =
			(parsed['servers'] as Record<string, unknown> | undefined) ??
			(parsed['mcpServers'] as Record<string, unknown> | undefined);

		if (!serversObj || typeof serversObj !== 'object') {
			this.showWarning('Tip: Add a "servers" or "mcpServers" key to define MCP servers.');
			this.saveBtn.disabled = false;
			return true;
		}

		// Validate each server
		for (const [name, rawCfg] of Object.entries(serversObj)) {
			const row = this.serversEl.createDiv({cls: 'sidekick-mcp-editor-server-row'});
			const nameEl = row.createSpan({cls: 'sidekick-mcp-editor-server-name', text: name});

			if (!rawCfg || typeof rawCfg !== 'object') {
				row.createSpan({cls: 'sidekick-mcp-editor-server-issue is-error', text: 'Invalid config (not an object)'});
				continue;
			}

			const cfg = rawCfg as Record<string, unknown>;
			const serverType = cfg['type'] as string | undefined;
			const issues: string[] = [];

			if (serverType === 'http' || serverType === 'sse') {
				if (!cfg['url'] || typeof cfg['url'] !== 'string') {
					issues.push('Missing "url"');
				}
				const typeTag = row.createSpan({cls: 'sidekick-mcp-editor-server-tag', text: serverType});
				typeTag.setAttribute('title', cfg['url'] as string || '');
			} else if (cfg['command']) {
				const typeTag = row.createSpan({cls: 'sidekick-mcp-editor-server-tag', text: 'stdio'});
				typeTag.setAttribute('title', `${cfg['command']} ${(cfg['args'] as string[] || []).join(' ')}`);
			} else if (!serverType) {
				issues.push('Missing "type" or "command"');
			}

			// Check tools config
			const tools = cfg['tools'] as unknown;
			if (tools !== undefined && !Array.isArray(tools)) {
				issues.push('"tools" must be an array');
			}

			if (issues.length > 0) {
				for (const issue of issues) {
					row.createSpan({cls: 'sidekick-mcp-editor-server-issue is-warning', text: issue});
				}
			} else {
				row.createSpan({cls: 'sidekick-mcp-editor-server-ok', text: '✓'});
			}

			// Test button
			const testBtn = row.createEl('button', {cls: 'clickable-icon sidekick-mcp-editor-test-btn', attr: {title: `Test ${name}`}});
			setIcon(testBtn, 'play');
			testBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.testServer(name, cfg, testBtn);
			});
		}

		this.saveBtn.disabled = false;
		return true;
	}

	/** Test a single MCP server by probing it and logging results. */
	private async testServer(name: string, cfg: Record<string, unknown>, btn: HTMLElement): Promise<void> {
		btn.addClass('is-testing');
		const statusEl = btn.parentElement?.querySelector('.sidekick-mcp-editor-server-ok, .sidekick-mcp-editor-server-result');
		const entry: McpServerEntry = {name, config: {...cfg}};

		console.group(`[Sidekick MCP Test] ${name}`);
		console.log('Config:', JSON.parse(JSON.stringify(cfg)));

		try {
			// Enrich with Azure CLI auth if applicable
			await enrichServersWithAzureAuth([entry]);

			const result = await probeMcpServer(entry);
			console.log('Probe result:', result);

			if (result.tools.length > 0) {
				console.log(`✅ ${name}: ${result.tools.length} tools found`);
				console.table(result.tools.map(t => ({name: t.name, description: t.description})));
				new Notice(`${name}: ${result.tools.length} tools found`);
				this.updateServerResult(btn.parentElement!, 'connected', `${result.tools.length} tools`);
			} else if (result.skipped) {
				console.log(`⏭ ${name}: Skipped (proxy-only, auth handled by Copilot SDK)`);
				new Notice(`${name}: Proxy-only — auth handled by Copilot SDK at runtime`);
				this.updateServerResult(btn.parentElement!, 'skipped', 'SDK auth');
			} else if (result.error) {
				console.warn(`❌ ${name}: ${result.error}`);
				if (result.httpStatus) console.log('HTTP status:', result.httpStatus);
				new Notice(`${name}: ${result.error}`);
				this.updateServerResult(btn.parentElement!, 'error', result.error.substring(0, 40));
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`❌ ${name}: ${msg}`);
			new Notice(`${name}: ${msg}`);
			this.updateServerResult(btn.parentElement!, 'error', msg.substring(0, 40));
		}
		console.groupEnd();
		btn.removeClass('is-testing');
	}

	/** Update the status indicator for a server row after testing. */
	private updateServerResult(row: Element, status: 'connected' | 'skipped' | 'error', text: string): void {
		const existing = row.querySelector('.sidekick-mcp-editor-server-ok, .sidekick-mcp-editor-server-result');
		if (existing) existing.remove();
		const el = row.createSpan({cls: 'sidekick-mcp-editor-server-result'});
		el.toggleClass('is-connected', status === 'connected');
		el.toggleClass('is-skipped', status === 'skipped');
		el.toggleClass('is-error', status === 'error');
		el.setText(text);
	}

	/** Test all servers sequentially. */
	private async testAllServers(): Promise<void> {
		const text = this.textArea.value.trim();
		if (!text) return;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text);
		} catch { return; }

		const serversObj =
			(parsed['servers'] as Record<string, unknown> | undefined) ??
			(parsed['mcpServers'] as Record<string, unknown> | undefined);
		if (!serversObj) return;

		console.group('[Sidekick MCP Test] Testing all servers');
		for (const [name, rawCfg] of Object.entries(serversObj)) {
			if (!rawCfg || typeof rawCfg !== 'object') continue;
			const btn = this.serversEl.querySelector(`.sidekick-mcp-editor-server-row .sidekick-mcp-editor-test-btn`);
			const rows = this.serversEl.querySelectorAll('.sidekick-mcp-editor-server-row');
			for (const row of rows) {
				const nameEl = row.querySelector('.sidekick-mcp-editor-server-name');
				if (nameEl?.textContent === name) {
					const testBtn = row.querySelector('.sidekick-mcp-editor-test-btn');
					if (testBtn) {
						await this.testServer(name, rawCfg as Record<string, unknown>, testBtn as HTMLElement);
					}
					break;
				}
			}
		}
		console.groupEnd();
	}

	private showError(msg: string): void {
		this.errorEl.empty();
		this.errorEl.createSpan({cls: 'sidekick-mcp-editor-error-text is-error', text: msg});
		this.textArea.addClass('is-invalid');
		this.saveBtn.disabled = true;
	}

	private showWarning(msg: string): void {
		this.errorEl.empty();
		this.errorEl.createSpan({cls: 'sidekick-mcp-editor-error-text is-warning', text: msg});
	}

	private async save(): Promise<void> {
		const text = this.textArea.value.trim();
		if (text && !this.validate()) return;

		try {
			const file = this.app.vault.getAbstractFileByPath(this.mcpPath);
			if (file && file instanceof TFile) {
				await this.app.vault.modify(file, text || '{}');
			} else {
				const folderPath = this.mcpPath.replace(/\/[^/]+$/, '');
				if (!this.app.vault.getAbstractFileByPath(folderPath)) {
					await this.app.vault.createFolder(folderPath);
				}
				await this.app.vault.create(this.mcpPath, text || '{}');
			}
			new Notice('mcp.json saved');
			this.onSaved();
			this.close();
		} catch (e) {
			new Notice(`Failed to save mcp.json: ${String(e)}`);
		}
	}
}
