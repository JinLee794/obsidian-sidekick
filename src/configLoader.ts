import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, SkillInfo, McpServerEntry, PromptConfig, TriggerConfig, TriggerEntry} from './types';

/** Module-level compiled regex for frontmatter detection. */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns parsed key-value pairs and the body after the frontmatter block.
 */
function parseFrontmatter(content: string): {meta: Record<string, string | string[]>; body: string} {
	const match = content.match(FM_RE);
	if (!match) return {meta: {}, body: content};
	const meta: Record<string, string | string[]> = {};
	const lines = (match[1] ?? '').split('\n');
	let currentKey = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const idx = line.indexOf(':');
		if (idx > 0 && !line.match(/^\s+-/)) {
			const key = line.slice(0, idx).trim();
			const val = line.slice(idx + 1).trim();
			if (key) {
				currentKey = key;
				meta[key] = val;
			}
		} else if (currentKey) {
			// Check for YAML list item (  - value)
			const listMatch = line.match(/^\s+-\s+(.+)/);
			if (listMatch) {
				const prev = meta[currentKey];
				if (Array.isArray(prev)) {
					prev.push(listMatch[1]!.trim());
				} else {
					// Convert from scalar (empty or value) to array
					const arr: string[] = prev && typeof prev === 'string' && prev.length > 0 ? [prev] : [];
					arr.push(listMatch[1]!.trim());
					meta[currentKey] = arr;
				}
			}
		}
	}
	return {meta, body: match[2] ?? ''};
}

/**
 * Load all agent configurations from *.agent.md files in the given vault folder.
 */
export async function loadAgents(app: App, agentsFolder: string): Promise<AgentConfig[]> {
	const folder = normalizePath(agentsFolder);
	const agents: AgentConfig[] = [];
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return agents;

	const agentFiles = abstract.children.filter(
		(child): child is TFile => child instanceof TFile && child.extension === 'md' && child.name.endsWith('.agent.md')
	);
	const contents = await Promise.all(agentFiles.map(f => app.vault.read(f)));

	for (let i = 0; i < agentFiles.length; i++) {
		const child = agentFiles[i]!;
		const content = contents[i]!;
		const {meta, body} = parseFrontmatter(content);
		const rawTools = meta['tools'];
		const rawSkills = meta['skills'];
		agents.push({
			name: (typeof meta['name'] === 'string' ? meta['name'] : '') || child.basename.replace('.agent', ''),
			description: (typeof meta['description'] === 'string' ? meta['description'] : '') || '',
			model: (typeof meta['model'] === 'string' && meta['model']) || undefined,
			tools: Array.isArray(rawTools) ? rawTools : (typeof rawTools === 'string' && rawTools ? rawTools.split(',').map(t => t.trim()).filter(Boolean) : undefined),
			skills: Array.isArray(rawSkills) ? rawSkills : (typeof rawSkills === 'string' && rawSkills ? rawSkills.split(',').map(s => s.trim()).filter(Boolean) : undefined),
			instructions: body.trim(),
			filePath: child.path,
		});
	}
	return agents;
}

/**
 * Load all skill definitions from sub-folders containing SKILL.md in the given vault folder.
 */
export async function loadSkills(app: App, skillsFolder: string): Promise<SkillInfo[]> {
	const folder = normalizePath(skillsFolder);
	const skills: SkillInfo[] = [];
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return skills;

	const skillFolders = abstract.children.filter((child): child is TFolder => child instanceof TFolder);
	const skillFiles = skillFolders.map(child => {
		const f = app.vault.getAbstractFileByPath(normalizePath(`${child.path}/SKILL.md`));
		return f instanceof TFile ? {folder: child, file: f} : null;
	}).filter((x): x is {folder: TFolder; file: TFile} => x !== null);

	const contents = await Promise.all(skillFiles.map(s => app.vault.read(s.file)));

	for (let i = 0; i < skillFiles.length; i++) {
		const {folder: child} = skillFiles[i]!;
		const content = contents[i]!;
		const {meta} = parseFrontmatter(content);
		skills.push({
			name: (typeof meta['name'] === 'string' ? meta['name'] : '') || child.name,
			description: (typeof meta['description'] === 'string' ? meta['description'] : '') || '',
			folderPath: child.path,
		});
	}
	return skills;
}

/**
 * Load all prompt templates from *.prompt.md files in the given vault folder.
 */
export async function loadPrompts(app: App, promptsFolder: string): Promise<PromptConfig[]> {
	const folder = normalizePath(promptsFolder);
	const prompts: PromptConfig[] = [];
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return prompts;

	const promptFiles = abstract.children.filter(
		(child): child is TFile => child instanceof TFile && child.extension === 'md' && child.name.endsWith('.prompt.md')
	);
	const contents = await Promise.all(promptFiles.map(f => app.vault.read(f)));

	for (let i = 0; i < promptFiles.length; i++) {
		const child = promptFiles[i]!;
		const content = contents[i]!;
		const {meta, body} = parseFrontmatter(content);
		prompts.push({
			name: child.basename.replace('.prompt', ''),
			agent: (typeof meta['agent'] === 'string' && meta['agent']) || undefined,
			description: (typeof meta['description'] === 'string' && meta['description']) || undefined,
			content: body.trim(),
		});
	}
	return prompts;
}

/**
 * Load MCP server entries from mcp.json in the given vault tools folder.
 * Supports both { "servers": { ... } } and { "mcpServers": { ... } } formats.
 */
export async function loadMcpServers(app: App, toolsFolder: string): Promise<McpServerEntry[]> {
	const mcpPath = normalizePath(`${toolsFolder}/mcp.json`);
	const entries: McpServerEntry[] = [];
	if (!(await app.vault.adapter.exists(mcpPath))) return entries;

	try {
		const content = await app.vault.adapter.read(mcpPath);
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object') return entries;

		// Accept both "servers" and "mcpServers" keys
		const serversObj =
			(parsed['servers'] as Record<string, unknown> | undefined) ??
			(parsed['mcpServers'] as Record<string, unknown> | undefined);

		if (serversObj && typeof serversObj === 'object') {
			for (const [name, config] of Object.entries(serversObj)) {
				if (config && typeof config === 'object') {
					entries.push({name, config: config as Record<string, unknown>});
				}
			}
		}
	} catch (e) {
		console.error('Sidekick: failed to parse mcp.json', e);
	}
	return entries;
}

/**
 * Parse a YAML triggers array from raw frontmatter text.
 * Handles the nested structure: triggers:\n  - type: ...\n    cron: ...
 */
function parseTriggerEntries(raw: string): TriggerEntry[] {
	const entries: TriggerEntry[] = [];
	// Find the triggers: block
	const triggersMatch = raw.match(/^triggers:\s*(?:#.*)?$/m);
	if (!triggersMatch) return entries;

	const startIdx = (triggersMatch.index ?? 0) + triggersMatch[0].length;
	const lines = raw.slice(startIdx).split('\n');

	let current: Partial<TriggerEntry> | null = null;
	for (const line of lines) {
		const trimmed = line.replace(/#.*$/, '').trimEnd();
		// Stop when we hit a non-indented, non-empty line (next top-level key)
		if (trimmed && !trimmed.startsWith(' ') && !trimmed.startsWith('\t')) break;
		if (!trimmed.trim()) continue;

		const itemMatch = trimmed.match(/^\s+-\s+type:\s*(.+)/);
		if (itemMatch) {
			if (current?.type) entries.push(current as TriggerEntry);
			current = {type: itemMatch[1]!.trim()};
			continue;
		}

		if (current) {
			const kvMatch = trimmed.match(/^\s+(\w+):\s*"?([^"]*)"?\s*$/);
			if (kvMatch) {
				const key = kvMatch[1]!.trim();
				const val = kvMatch[2]!.trim();
				if (key === 'cron') current.cron = val;
				else if (key === 'glob') current.glob = val;
			}
		}
	}
	if (current?.type) entries.push(current as TriggerEntry);
	return entries;
}

/**
 * Load all trigger configurations from *.trigger.md files in the given vault folder.
 */
export async function loadTriggers(app: App, triggersFolder: string): Promise<TriggerConfig[]> {
	const folder = normalizePath(triggersFolder);
	const triggers: TriggerConfig[] = [];
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return triggers;

	const triggerFiles = abstract.children.filter(
		(child): child is TFile => child instanceof TFile && child.extension === 'md' && child.name.endsWith('.trigger.md')
	);
	const contents = await Promise.all(triggerFiles.map(f => app.vault.read(f)));

	for (let i = 0; i < triggerFiles.length; i++) {
		const child = triggerFiles[i]!;
		const content = contents[i]!;
		const fmMatch = content.match(FM_RE);
		if (!fmMatch) continue;
		const rawFm = fmMatch[1] ?? '';
		const body = (fmMatch[2] ?? '').trim();
		// Parse frontmatter by wrapping in --- delimiters so parseFrontmatter can process it
		const {meta} = parseFrontmatter(`---\n${rawFm}\n---\n`);

		triggers.push({
			name: child.basename.replace('.trigger', ''),
			description: (typeof meta['description'] === 'string' && meta['description']) || undefined,
			agent: (typeof meta['agent'] === 'string' && meta['agent']) || undefined,
			enabled: String(meta['enabled']).toLowerCase() !== 'false',
			triggers: parseTriggerEntries(rawFm),
			content: body,
		});
	}
	return triggers;
}
