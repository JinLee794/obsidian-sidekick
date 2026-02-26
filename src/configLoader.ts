import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, SkillInfo, McpServerEntry, PromptConfig} from './types';

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns parsed key-value pairs and the body after the frontmatter block.
 */
function parseFrontmatter(content: string): {meta: Record<string, string>; body: string} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return {meta: {}, body: content};
	const meta: Record<string, string> = {};
	for (const line of (match[1] ?? '').split('\n')) {
		const idx = line.indexOf(':');
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			const val = line.slice(idx + 1).trim();
			if (key) meta[key] = val;
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

	for (const child of abstract.children) {
		if (child instanceof TFile && child.extension === 'md' && child.name.endsWith('.agent.md')) {
			const content = await app.vault.read(child);
			const {meta, body} = parseFrontmatter(content);
			agents.push({
				name: meta['name'] ?? child.basename.replace('.agent', ''),
				description: meta['description'] ?? '',
				model: meta['model'] || undefined,
				tools: meta['tools'] || undefined,
				instructions: body.trim(),
				filePath: child.path,
			});
		}
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

	for (const child of abstract.children) {
		if (child instanceof TFolder) {
			const skillFile = app.vault.getAbstractFileByPath(normalizePath(`${child.path}/SKILL.md`));
			if (skillFile instanceof TFile) {
				const content = await app.vault.read(skillFile);
				const {meta} = parseFrontmatter(content);
				skills.push({
					name: meta['name'] ?? child.name,
					description: meta['description'] ?? '',
					folderPath: child.path,
				});
			}
		}
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

	for (const child of abstract.children) {
		if (child instanceof TFile && child.extension === 'md' && child.name.endsWith('.prompt.md')) {
			const content = await app.vault.read(child);
			const {meta, body} = parseFrontmatter(content);
			prompts.push({
				name: child.basename.replace('.prompt', ''),
				agent: meta['agent'] || undefined,
				description: meta['description'] || undefined,
				content: body.trim(),
			});
		}
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
