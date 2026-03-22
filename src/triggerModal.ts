import {App, Modal, Notice, Setting, normalizePath, setIcon} from 'obsidian';
import type {AgentConfig} from './types';
import type {ModelInfo} from './copilot';

/** Cron schedule preset for quick selection. */
interface CronPreset {
	label: string;
	cron: string;
	description: string;
}

const CRON_PRESETS: CronPreset[] = [
	{label: 'Every morning at 8 AM', cron: '0 8 * * *', description: 'Runs once daily at 08:00'},
	{label: 'Every evening at 6 PM', cron: '0 18 * * *', description: 'Runs once daily at 18:00'},
	{label: 'Every hour', cron: '0 * * * *', description: 'Runs at the top of every hour'},
	{label: 'Every 30 minutes', cron: '*/30 * * * *', description: 'Runs every half-hour'},
	{label: 'Weekdays at 9 AM', cron: '0 9 * * 1-5', description: 'Mon–Fri at 09:00'},
	{label: 'Sunday evening at 5 PM', cron: '0 17 * * 0', description: 'Every Sunday at 17:00'},
	{label: 'Every Monday at 9 AM', cron: '0 9 * * 1', description: 'Weekly on Monday at 09:00'},
	{label: 'Every Friday at 4 PM', cron: '0 16 * * 5', description: 'End-of-week wrap-up, every Friday at 16:00'},
	{label: 'Twice a day (8 AM & 8 PM)', cron: '0 8,20 * * *', description: 'Runs at 08:00 and 20:00 daily'},
	{label: 'First of the month', cron: '0 9 1 * *', description: '1st of each month at 09:00'},
	{label: 'Custom', cron: '', description: 'Enter a custom 5-field cron expression'},
];

/** Prompt quality issue detected during validation. */
interface PromptIssue {
	severity: 'warning' | 'error';
	message: string;
}

/** Validate trigger prompt for quality and specificity. */
function validatePrompt(prompt: string): PromptIssue[] {
	const issues: PromptIssue[] = [];
	const trimmed = prompt.trim();
	const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

	if (!trimmed) {
		issues.push({severity: 'error', message: 'Prompt cannot be empty.'});
		return issues;
	}

	if (wordCount < 5) {
		issues.push({severity: 'error', message: 'Prompt is too short. Provide at least a sentence describing what the trigger should do.'});
	}

	// Vague / overly broad patterns
	const vaguePatterns = [
		{re: /^(do something|help me|do stuff|make it better|fix things)/i, msg: 'Prompt is too vague. Describe a specific outcome (e.g., "Summarize today\'s meeting notes into action items").'},
		{re: /^(do everything|handle all|manage everything|process all|check everything)/i, msg: 'Prompt is too broad. Focus on one well-defined task per trigger.'},
		{re: /^(hi|hello|hey|yo)\b/i, msg: 'A trigger prompt should be an instruction, not a greeting.'},
	];
	for (const {re, msg} of vaguePatterns) {
		if (re.test(trimmed)) {
			issues.push({severity: 'error', message: msg});
		}
	}

	// Warn on broad scope without specifics
	if (wordCount < 10 && /\b(all|every|everything|anything)\b/i.test(trimmed) && !/\b(all\s+\w+\s+files|every\s+(morning|evening|week|day|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(trimmed)) {
		issues.push({severity: 'warning', message: 'Consider narrowing the scope. Triggers work best with focused, specific tasks rather than sweeping instructions.'});
	}

	// No actionable verb
	const hasVerb = /\b(summarize|create|list|review|update|check|generate|prepare|analyze|compile|organize|send|format|extract|track|remind|report|collect|draft|prioritize|schedule|plan|clean|archive|move|rename|tag|sort)\b/i.test(trimmed);
	if (!hasVerb && wordCount >= 5) {
		issues.push({severity: 'warning', message: 'Tip: Start with an action verb (e.g., "Summarize…", "List…", "Review…") so the trigger has a clear task.'});
	}

	return issues;
}

/** Validate a trigger name for file-system safety. */
function validateTriggerName(name: string): string | null {
	if (!name.trim()) return 'Name is required.';
	if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name.trim())) {
		return 'Name must start with a letter or number and contain only letters, numbers, spaces, hyphens, or underscores.';
	}
	if (name.trim().length > 60) return 'Name must be 60 characters or fewer.';
	return null;
}

/** Convert a trigger name to a safe filename slug. */
function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

/** Validate a 5-field cron expression (basic structural check). */
function validateCron(cron: string): string | null {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return 'Cron must have exactly 5 fields: minute hour day-of-month month day-of-week.';
	// Very basic range check per field
	const ranges = [{min: 0, max: 59}, {min: 0, max: 23}, {min: 1, max: 31}, {min: 1, max: 12}, {min: 0, max: 6}];
	const fieldNames = ['Minute', 'Hour', 'Day-of-month', 'Month', 'Day-of-week'];
	for (let i = 0; i < 5; i++) {
		const field = parts[i]!;
		if (field === '*') continue;
		// Allow step expressions */N
		if (/^\*\/\d+$/.test(field)) continue;
		// Allow ranges, lists, and range-steps
		if (/^[\d,*/-]+$/.test(field)) continue;
		return `${fieldNames[i]} field "${field}" looks invalid. Use numbers, *, ranges (1-5), lists (1,3,5), or steps (*/5).`;
	}
	return null;
}

export interface NewTriggerResult {
	fileName: string;
	content: string;
}

/**
 * Modal for creating a new trigger via guided form.
 * Produces a *.trigger.md file with proper frontmatter annotations.
 */
export class NewTriggerModal extends Modal {
	private agents: AgentConfig[];
	private models: ModelInfo[];
	private triggersFolder: string;
	private onCreated: () => void;

	// Form state
	private triggerName = '';
	private description = '';
	private selectedAgent = '';
	private selectedModel = '';
	private scheduleType: 'cron' | 'glob' | 'both' = 'cron';
	private selectedPreset = 0; // index into CRON_PRESETS
	private customCron = '';
	private glob = '';
	private prompt = '';
	private enabled = true;
	private selectedIcon = 'zap';

	// UI elements for dynamic updates
	private promptIssuesEl!: HTMLElement;
	private cronPreviewEl!: HTMLElement;
	private cronCustomRow!: HTMLElement;
	private nameErrorEl!: HTMLElement;
	private cronErrorEl!: HTMLElement;
	private createBtn!: HTMLButtonElement;

	constructor(app: App, agents: AgentConfig[], models: ModelInfo[], triggersFolder: string, onCreated: () => void) {
		super(app);
		this.agents = agents;
		this.models = models;
		this.triggersFolder = triggersFolder;
		this.onCreated = onCreated;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('sidekick-new-trigger-modal');
		contentEl.createEl('h3', {text: 'New trigger'});

		// ── Best practices guidance ──────────────────────────
		const guidance = contentEl.createDiv({cls: 'sidekick-trigger-guidance'});
		const guideDetails = guidance.createEl('details');
		guideDetails.createEl('summary', {text: 'Best practices for triggers'});
		const guideList = guideDetails.createEl('ul');
		guideList.createEl('li', {text: 'Be specific: "Summarize today\'s meeting notes into action items" is better than "help me with notes".'});
		guideList.createEl('li', {text: 'One task per trigger: Keep each trigger focused on a single responsibility.'});
		guideList.createEl('li', {text: 'Start with an action verb: Summarize, List, Review, Generate, Prepare, etc.'});
		guideList.createEl('li', {text: 'Set appropriate frequency: Don\'t run expensive triggers more often than needed.'});
		guideList.createEl('li', {text: 'Use file-change triggers for reactive tasks and cron triggers for scheduled tasks.'});
		guideList.createEl('li', {text: 'Test with generous schedules first, then tighten once you\'re happy with the output.'});

		// ── Name ─────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Name')
			.setDesc('A short, descriptive name for this trigger.')
			.addText(text => {
				text.setPlaceholder('e.g., Daily planner');
				text.onChange(v => {
					this.triggerName = v;
					this.validateForm();
				});
			});
		this.nameErrorEl = contentEl.createDiv({cls: 'sidekick-trigger-field-error'});

		// ── Description (optional) ───────────────────────────
		new Setting(contentEl)
			.setName('Description')
			.setDesc('Optional description of what this trigger does.')
			.addText(text => {
				text.setPlaceholder('e.g., Prepares a plan for the day every morning');
				text.onChange(v => { this.description = v; });
			});

		// ── Icon ─────────────────────────────────────────────
		const TRIGGER_ICON_CHOICES: {value: string; label: string}[] = [
			{value: 'zap', label: 'Zap (default)'},
			{value: 'clock', label: 'Clock'},
			{value: 'calendar', label: 'Calendar'},
			{value: 'bell', label: 'Bell'},
			{value: 'star', label: 'Star'},
			{value: 'heart', label: 'Heart'},
			{value: 'bookmark', label: 'Bookmark'},
			{value: 'flag', label: 'Flag'},
			{value: 'target', label: 'Target'},
			{value: 'rocket', label: 'Rocket'},
			{value: 'brain', label: 'Brain'},
			{value: 'eye', label: 'Eye'},
			{value: 'file-text', label: 'File'},
			{value: 'folder', label: 'Folder'},
			{value: 'mail', label: 'Mail'},
			{value: 'megaphone', label: 'Megaphone'},
			{value: 'shield', label: 'Shield'},
			{value: 'sun', label: 'Sun'},
			{value: 'moon', label: 'Moon'},
			{value: 'cloud', label: 'Cloud'},
			{value: 'database', label: 'Database'},
			{value: 'git-branch', label: 'Git branch'},
			{value: 'list-checks', label: 'Checklist'},
			{value: 'activity', label: 'Activity'},
			{value: 'alert-circle', label: 'Alert'},
			{value: 'archive', label: 'Archive'},
			{value: 'bar-chart-2', label: 'Chart'},
			{value: 'refresh-cw', label: 'Refresh'},
			{value: 'send', label: 'Send'},
			{value: 'sparkles', label: 'Sparkles'},
		];
		const iconSetting = new Setting(contentEl)
			.setName('Icon')
			.setDesc('Icon shown in session history for this trigger.');
		const iconPreview = iconSetting.controlEl.createSpan({cls: 'sidekick-trigger-icon-preview'});
		setIcon(iconPreview, this.selectedIcon);
		iconSetting.addDropdown(dd => {
			for (const {value, label} of TRIGGER_ICON_CHOICES) {
				dd.addOption(value, label);
			}
			dd.setValue(this.selectedIcon);
			dd.onChange(v => {
				this.selectedIcon = v;
				iconPreview.empty();
				setIcon(iconPreview, v);
			});
		});

		// ── Agent ────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Agent')
			.setDesc('Which agent should handle this trigger.')
			.addDropdown(dd => {
				dd.addOption('', '(Default chat)');
				for (const agent of this.agents) {
					dd.addOption(agent.name, agent.name);
				}
				dd.onChange(v => { this.selectedAgent = v; });
			});

		// ── Model ────────────────────────────────────────────
		new Setting(contentEl)
			.setName('Model')
			.setDesc('Which model to use when this trigger fires. Leave as default to use the agent or session model.')
			.addDropdown(dd => {
				dd.addOption('', '(Default)');
				for (const model of this.models) {
					dd.addOption(model.id, model.name || model.id);
				}
				dd.onChange(v => { this.selectedModel = v; });
			});

		// ── Schedule type ────────────────────────────────────
		new Setting(contentEl)
			.setName('Schedule type')
			.setDesc('How this trigger is activated.')
			.addDropdown(dd => {
				dd.addOption('cron', 'Scheduled (cron)');
				dd.addOption('glob', 'On file change (glob)');
				dd.addOption('both', 'Both (cron + glob)');
				dd.setValue(this.scheduleType);
				dd.onChange(v => {
					this.scheduleType = v as 'cron' | 'glob' | 'both';
					this.updateScheduleVisibility();
					this.validateForm();
				});
			});

		// ── Cron section ─────────────────────────────────────
		const cronSection = contentEl.createDiv({cls: 'sidekick-trigger-cron-section'});
		cronSection.dataset['section'] = 'cron';

		new Setting(cronSection)
			.setName('Schedule')
			.setDesc('When should this trigger run?')
			.addDropdown(dd => {
				for (let i = 0; i < CRON_PRESETS.length; i++) {
					dd.addOption(String(i), CRON_PRESETS[i]!.label);
				}
				dd.onChange(v => {
					this.selectedPreset = parseInt(v, 10);
					const preset = CRON_PRESETS[this.selectedPreset];
					if (preset && preset.cron) {
						this.customCron = preset.cron;
					}
					this.updateCronPreview();
					this.validateForm();
				});
			});

		this.cronPreviewEl = cronSection.createDiv({cls: 'sidekick-trigger-cron-preview'});

		this.cronCustomRow = cronSection.createDiv({cls: 'sidekick-trigger-custom-cron'});
		new Setting(this.cronCustomRow)
			.setName('Cron expression')
			.setDesc('5 fields: minute hour day-of-month month day-of-week. Example: 0 8 * * 1-5')
			.addText(text => {
				text.setPlaceholder('0 8 * * *');
				text.onChange(v => {
					this.customCron = v;
					this.updateCronPreview();
					this.validateForm();
				});
			});

		// Human-readable cron examples
		const cronExamples = cronSection.createDiv({cls: 'sidekick-trigger-cron-examples'});
		cronExamples.createEl('span', {text: 'Examples: ', cls: 'sidekick-trigger-cron-examples-label'});
		const examples = [
			{cron: '0 7 * * *', label: 'Every day at 7 AM'},
			{cron: '0 17 * * 0', label: 'Sunday at 5 PM'},
			{cron: '30 9 * * 1-5', label: 'Weekdays at 9:30 AM'},
			{cron: '0 */2 * * *', label: 'Every 2 hours'},
		];
		for (const ex of examples) {
			const chip = cronExamples.createEl('button', {
				text: ex.label,
				cls: 'sidekick-trigger-cron-example-chip',
				attr: {type: 'button'},
			});
			chip.addEventListener('click', () => {
				this.customCron = ex.cron;
				// Switch to Custom preset
				this.selectedPreset = CRON_PRESETS.length - 1;
				const presetDropdown = cronSection.querySelector('select') as HTMLSelectElement | null;
				if (presetDropdown) presetDropdown.value = String(this.selectedPreset);
				// Update the custom cron text input
				const customInput = this.cronCustomRow.querySelector('input') as HTMLInputElement | null;
				if (customInput) customInput.value = ex.cron;
				this.updateCronPreview();
				this.validateForm();
			});
		}

		this.cronErrorEl = cronSection.createDiv({cls: 'sidekick-trigger-field-error'});

		// ── Glob section ─────────────────────────────────────
		const globSection = contentEl.createDiv({cls: 'sidekick-trigger-glob-section'});
		globSection.dataset['section'] = 'glob';

		new Setting(globSection)
			.setName('File pattern (glob)')
			.setDesc('Which files should activate this trigger when modified. Example: **/*.md')
			.addText(text => {
				text.setPlaceholder('**/*.md');
				text.onChange(v => {
					this.glob = v;
					this.validateForm();
				});
			});

		// ── Prompt ───────────────────────────────────────────
		const promptSetting = new Setting(contentEl)
			.setName('Prompt')
			.setDesc('The instruction sent to the agent when this trigger fires. Be specific and action-oriented.');
		const promptArea = contentEl.createEl('textarea', {
			cls: 'sidekick-trigger-prompt-textarea',
			attr: {
				placeholder: 'e.g., Review all notes modified today and create a summary of key decisions and action items in my Daily Notes folder.',
				rows: '5',
			},
		});
		promptArea.addEventListener('input', () => {
			this.prompt = promptArea.value;
			this.validatePromptLive();
			this.validateForm();
		});
		// Also validate on blur for final feedback
		promptArea.addEventListener('blur', () => {
			this.validatePromptLive();
		});

		this.promptIssuesEl = contentEl.createDiv({cls: 'sidekick-trigger-prompt-issues'});

		// ── Enabled toggle ───────────────────────────────────
		new Setting(contentEl)
			.setName('Enabled')
			.setDesc('Whether this trigger is active immediately after creation.')
			.addToggle(toggle => {
				toggle.setValue(true);
				toggle.onChange(v => {
					this.enabled = v;
				});
			});

		// ── AI editing tip ────────────────────────────────────
		const aiTip = contentEl.createDiv({cls: 'sidekick-trigger-ai-tip'});
		const tipIcon = aiTip.createSpan({cls: 'sidekick-trigger-ai-tip-icon'});
		setIcon(tipIcon, 'sparkles');
		aiTip.createSpan({text: 'After creating, you can open the trigger file and ask Sidekick to refine it — e.g. "change this trigger to run every Sunday at 5 PM" or "make it only run on weekdays".'});

		// ── Actions ──────────────────────────────────────────
		const actions = contentEl.createDiv({cls: 'sidekick-trigger-actions'});
		const cancelBtn = actions.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());

		this.createBtn = actions.createEl('button', {text: 'Create trigger', cls: 'mod-cta'});
		this.createBtn.disabled = true;
		this.createBtn.addEventListener('click', () => void this.handleCreate());

		// Initial UI state
		this.updateScheduleVisibility();
		this.updateCronPreview();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Show/hide cron and glob sections based on schedule type. */
	private updateScheduleVisibility(): void {
		const cron = this.contentEl.querySelector('[data-section="cron"]') as HTMLElement | null;
		const glob = this.contentEl.querySelector('[data-section="glob"]') as HTMLElement | null;
		if (cron) cron.style.display = (this.scheduleType === 'cron' || this.scheduleType === 'both') ? '' : 'none';
		if (glob) glob.style.display = (this.scheduleType === 'glob' || this.scheduleType === 'both') ? '' : 'none';
		// Show custom cron input only when "Custom" preset is selected
		this.updateCustomCronVisibility();
	}

	private updateCustomCronVisibility(): void {
		const isCustom = this.selectedPreset === CRON_PRESETS.length - 1;
		if (this.cronCustomRow) {
			this.cronCustomRow.style.display = isCustom ? '' : 'none';
		}
	}

	private updateCronPreview(): void {
		this.updateCustomCronVisibility();
		const preset = CRON_PRESETS[this.selectedPreset];
		if (!preset) return;
		const cron = preset.cron || this.customCron;
		if (cron && this.cronPreviewEl) {
			this.cronPreviewEl.textContent = `Schedule: ${preset.cron ? preset.description : describeCronExpression(cron)}`;
			this.cronPreviewEl.style.display = '';
		} else if (this.cronPreviewEl) {
			this.cronPreviewEl.style.display = 'none';
		}
	}

	private validatePromptLive(): void {
		if (!this.promptIssuesEl) return;
		this.promptIssuesEl.empty();
		if (!this.prompt.trim()) return;

		const issues = validatePrompt(this.prompt);
		for (const issue of issues) {
			const el = this.promptIssuesEl.createDiv({cls: `sidekick-trigger-issue sidekick-trigger-issue-${issue.severity}`});
			const icon = el.createSpan({cls: 'sidekick-trigger-issue-icon'});
			setIcon(icon, issue.severity === 'error' ? 'alert-circle' : 'alert-triangle');
			el.createSpan({text: issue.message});
		}
	}

	/** Validate the full form and enable/disable the create button. */
	private validateForm(): void {
		let valid = true;

		// Name
		const nameErr = validateTriggerName(this.triggerName);
		if (this.nameErrorEl) {
			this.nameErrorEl.textContent = nameErr ?? '';
			this.nameErrorEl.style.display = nameErr ? '' : 'none';
		}
		if (nameErr) valid = false;

		// Cron (if applicable)
		if (this.scheduleType === 'cron' || this.scheduleType === 'both') {
			const cron = this.getEffectiveCron();
			const cronErr = cron ? validateCron(cron) : 'Select a schedule or enter a custom cron expression.';
			if (this.cronErrorEl) {
				this.cronErrorEl.textContent = cronErr ?? '';
				this.cronErrorEl.style.display = cronErr ? '' : 'none';
			}
			if (cronErr) valid = false;
		} else if (this.cronErrorEl) {
			this.cronErrorEl.textContent = '';
			this.cronErrorEl.style.display = 'none';
		}

		// Glob (if applicable)
		if ((this.scheduleType === 'glob' || this.scheduleType === 'both') && !this.glob.trim()) {
			valid = false;
		}

		// Prompt — block on errors only
		const promptIssues = validatePrompt(this.prompt);
		if (promptIssues.some(i => i.severity === 'error')) valid = false;

		if (this.createBtn) this.createBtn.disabled = !valid;
	}

	private getEffectiveCron(): string {
		const preset = CRON_PRESETS[this.selectedPreset];
		if (preset && preset.cron) return preset.cron;
		return this.customCron.trim();
	}

	/** Build the markdown content and create the file. */
	private async handleCreate(): Promise<void> {
		const name = this.triggerName.trim();
		const slug = slugify(name);
		const fileName = `${slug}.trigger.md`;
		const filePath = normalizePath(`${this.triggersFolder}/${fileName}`);

		// Check if file already exists
		if (this.app.vault.getAbstractFileByPath(filePath)) {
			new Notice(`A trigger file "${fileName}" already exists. Choose a different name.`);
			return;
		}

		// Build frontmatter
		const fmLines: string[] = ['---'];
		fmLines.push(`name: ${name}`);
		if (this.description.trim()) fmLines.push(`description: ${this.description.trim()}`);
		if (this.selectedAgent) fmLines.push(`agent: ${this.selectedAgent}`);
		if (this.selectedModel) fmLines.push(`model: ${this.selectedModel}`);
		if (this.selectedIcon && this.selectedIcon !== 'zap') fmLines.push(`icon: ${this.selectedIcon}`);

		if (this.scheduleType === 'cron' || this.scheduleType === 'both') {
			fmLines.push(`cron: "${this.getEffectiveCron()}"`);
		}
		if (this.scheduleType === 'glob' || this.scheduleType === 'both') {
			fmLines.push(`glob: "${this.glob.trim()}"`);
		}

		fmLines.push(`enabled: ${this.enabled}`);
		fmLines.push('---');

		const content = fmLines.join('\n') + '\n' + this.prompt.trim() + '\n';

		// Ensure triggers folder exists
		const folderAbstract = this.app.vault.getAbstractFileByPath(this.triggersFolder);
		if (!folderAbstract) {
			await this.app.vault.createFolder(this.triggersFolder);
		}

		await this.app.vault.create(filePath, content);
		new Notice(`Trigger "${name}" created.`);
		this.close();
		this.onCreated();
	}
}

/** Human-readable description for arbitrary cron expressions. */
function describeCronExpression(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return cron;
	const [min, hour, dom, mon, dow] = parts;

	const everyMin = min!.match(/^\*\/(\d+)$/);
	if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
		return `Every ${everyMin[1]} minute(s)`;
	}
	// Every N hours: 0 */2 * * *
	const everyHour = hour!.match(/^\*\/(\d+)$/);
	if (/^\d+$/.test(min!) && everyHour && dom === '*' && mon === '*' && dow === '*') {
		return `Every ${everyHour[1]} hour(s) at :${min!.padStart(2, '0')}`;
	}
	// Multiple times daily: 0 8,20 * * *
	if (/^\d+$/.test(min!) && /^[\d,]+$/.test(hour!) && hour!.includes(',') && dom === '*' && mon === '*' && dow === '*') {
		const hours = hour!.split(',').map(h => `${h.padStart(2, '0')}:${min!.padStart(2, '0')}`);
		return `Daily at ${hours.join(' & ')}`;
	}
	if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === '*' && mon === '*' && dow === '*') {
		return `Daily at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
	}
	if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && dom === '*' && mon === '*' && /^[\d,-]+$/.test(dow!)) {
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const dayParts = dow!.split(',').map(d => {
			if (d.includes('-')) {
				const [s, e] = d.split('-');
				return `${dayNames[parseInt(s!, 10)] ?? s}–${dayNames[parseInt(e!, 10)] ?? e}`;
			}
			return dayNames[parseInt(d, 10)] ?? d;
		});
		return `${dayParts.join(', ')} at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
	}
	if (/^\d+$/.test(min!) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
		return `Hourly at :${min!.padStart(2, '0')}`;
	}
	if (/^\d+$/.test(min!) && /^\d+$/.test(hour!) && /^\d+$/.test(dom!) && mon === '*' && dow === '*') {
		return `Monthly on day ${dom} at ${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}`;
	}
	return `Cron: ${cron}`;
}
