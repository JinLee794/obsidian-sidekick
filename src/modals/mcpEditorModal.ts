import {App, Modal, Notice, TFile, normalizePath} from 'obsidian';

/**
 * Modal to view/edit the mcp.json configuration file directly from the tools view.
 * Provides live JSON validation with inline error feedback.
 */
export class McpEditorModal extends Modal {
	private readonly mcpPath: string;
	private textArea!: HTMLTextAreaElement;
	private errorEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private onSaved: () => void;

	constructor(app: App, toolsFolder: string, onSaved: () => void) {
		super(app);
		this.mcpPath = normalizePath(`${toolsFolder}/mcp.json`);
		this.onSaved = onSaved;
	}

	async onOpen(): Promise<void> {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-mcp-editor-modal');

		contentEl.createEl('h3', {text: 'Edit mcp.json'});

		const pathHint = contentEl.createDiv({cls: 'sidekick-mcp-editor-path'});
		pathHint.setText(this.mcpPath);

		// Load existing content
		let content = '';
		const file = this.app.vault.getAbstractFileByPath(this.mcpPath);
		if (file && file instanceof TFile) {
			content = await this.app.vault.read(file);
		} else {
			// Provide a starter template when file doesn't exist
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

		// Button row
		const btnRow = contentEl.createDiv({cls: 'sidekick-mcp-editor-buttons'});

		this.saveBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Save'});
		this.saveBtn.addEventListener('click', () => void this.save());

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());

		// Run initial validation
		this.validate();
	}

	/** Validate JSON and update UI. Returns true if valid. */
	private validate(): boolean {
		const text = this.textArea.value.trim();
		this.errorEl.empty();
		this.textArea.removeClass('is-invalid');

		if (!text) {
			// Empty is technically invalid but we allow saving an empty file
			this.saveBtn.disabled = false;
			return true;
		}

		try {
			const parsed = JSON.parse(text);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				this.showError('JSON must be an object (e.g. { "servers": { ... } })');
				return false;
			}
			// Warn if neither "servers" nor "mcpServers" key is present
			if (!('servers' in parsed) && !('mcpServers' in parsed)) {
				this.showWarning('Tip: Add a "servers" or "mcpServers" key to define MCP servers.');
			}
			this.saveBtn.disabled = false;
			return true;
		} catch (e) {
			const msg = e instanceof SyntaxError ? e.message : String(e);
			this.showError(`Invalid JSON: ${msg}`);
			return false;
		}
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

		// Re-validate before saving
		if (text && !this.validate()) return;

		try {
			const file = this.app.vault.getAbstractFileByPath(this.mcpPath);
			if (file && file instanceof TFile) {
				await this.app.vault.modify(file, text || '{}');
			} else {
				// Ensure parent folder exists
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
