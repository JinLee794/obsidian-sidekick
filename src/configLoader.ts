import {App, normalizePath, TFile, TFolder} from 'obsidian';
import type {AgentConfig, HandoffConfig, SkillInfo, McpServerEntry, McpAuthConfig, McpInputVariable, PromptConfig, TriggerConfig, AgencyConfig} from './types';

/** Module-level compiled regex for frontmatter detection. */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML-like frontmatter from markdown content.
 * Returns parsed key-value pairs and the body after the frontmatter block.
 */
function parseFrontmatter(content: string): {meta: Record<string, string | string[]>; body: string; rawYaml: string} {
	const match = content.match(FM_RE);
	if (!match) return {meta: {}, body: content, rawYaml: ''};
	const meta: Record<string, string | string[]> = {};
	const lines = (match[1] ?? '').split('\n');
	let currentKey = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const idx = line.indexOf(':');
		if (idx > 0 && !line.match(/^\s+-/)) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			// Strip surrounding quotes (single or double)
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
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
	return {meta, body: match[2] ?? '', rawYaml: match[1] ?? ''};
}

/**
 * Parse structured handoffs from raw YAML frontmatter text.
 * Supports both simple string lists and rich object lists.
 */
function parseHandoffsBlock(yamlText: string): HandoffConfig[] | undefined {
	const lines = yamlText.split('\n');
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^handoffs\s*:/.test(lines[i]!)) {
			startIdx = i + 1;
			break;
		}
	}
	if (startIdx === -1) return undefined;

	// Collect indented lines belonging to handoffs block
	const blockLines: string[] = [];
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === '') { blockLines.push(line); continue; }
		if (!/^\s/.test(line)) break; // non-indented = new top-level key
		blockLines.push(line);
	}
	if (blockLines.length === 0) return [];

	// Detect simple list ("- agent-name") vs structured ("- label: ...")
	const firstContent = blockLines.find(l => l.trim().startsWith('-'));
	if (!firstContent) return [];
	const afterDash = firstContent.replace(/^\s*-\s*/, '').trim();
	if (!afterDash.includes(':')) {
		// Simple string list — convert to HandoffConfig[]
		return blockLines
			.map(l => l.match(/^\s*-\s+(.+)/))
			.filter((m): m is RegExpMatchArray => m !== null)
			.map(m => ({label: m[1]!.trim(), agent: m[1]!.trim()}));
	}

	// Rich structured handoffs: list of objects
	const handoffs: HandoffConfig[] = [];
	let obj: Record<string, string> = {};
	let blockKey = '';
	let blockIndent = 0;

	const flush = () => {
		if (Object.keys(obj).length > 0) {
			handoffs.push({
				label: obj['label'] || obj['agent'] || '',
				agent: obj['agent'] || '',
				...(obj['prompt'] ? {prompt: obj['prompt'].trim()} : {}),
				...(obj['send'] !== undefined ? {send: obj['send'].toLowerCase() === 'true'} : {}),
				...(obj['model'] ? {model: obj['model']} : {}),
			});
		}
		obj = {};
		blockKey = '';
	};

	for (const line of blockLines) {
		// New list item ("  - key: value")
		const itemMatch = line.match(/^(\s*)-\s+(.+)/);
		if (itemMatch) {
			flush();
			blockIndent = (itemMatch[1]?.length ?? 0) + 2;
			const content = itemMatch[2]!.trim();
			const ci = content.indexOf(':');
			if (ci > 0) {
				const key = content.slice(0, ci).trim();
				const val = content.slice(ci + 1).trim();
				if (val === '|' || val === '>') {
					blockKey = key;
					obj[key] = '';
				} else {
					obj[key] = stripYamlQuotes(val);
				}
			}
			continue;
		}

		// Block scalar continuation
		if (blockKey) {
			const lineIndent = line.search(/\S/);
			if (lineIndent === -1) { obj[blockKey] += '\n'; continue; } // blank line in block
			if (lineIndent > blockIndent) {
				obj[blockKey] = obj[blockKey] ? obj[blockKey] + '\n' + line.trim() : line.trim();
				continue;
			}
			blockKey = '';
		}

		// Object property ("    agent: value")
		const propMatch = line.match(/^\s+([\w][\w-]*)\s*:\s*(.*)/);
		if (propMatch) {
			const key = propMatch[1]!.trim();
			const val = propMatch[2]!.trim();
			if (val === '|' || val === '>') {
				blockKey = key;
				blockIndent = line.search(/\S/);
				obj[key] = '';
			} else {
				obj[key] = stripYamlQuotes(val);
			}
		}
	}
	flush();
	return handoffs;
}

function stripYamlQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
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
		const {meta, body, rawYaml} = parseFrontmatter(content);
		const rawTools = meta['tools'];
		const rawSkills = meta['skills'];
		const handoffs = parseHandoffsBlock(rawYaml);
		agents.push({
			name: (typeof meta['name'] === 'string' ? meta['name'] : '') || child.basename.replace('.agent', ''),
			description: (typeof meta['description'] === 'string' ? meta['description'] : '') || '',
			model: (typeof meta['model'] === 'string' && meta['model']) || undefined,
			tools: Array.isArray(rawTools) ? rawTools : (typeof rawTools === 'string' && rawTools ? rawTools.split(',').map(t => t.trim()).filter(Boolean) : ('tools' in meta ? [] : undefined)),
			skills: Array.isArray(rawSkills) ? rawSkills : (typeof rawSkills === 'string' && rawSkills ? rawSkills.split(',').map(s => s.trim()).filter(Boolean) : ('skills' in meta ? [] : undefined)),
			handoffs,
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
 * Load MCP input variable definitions from mcp.json.
 */
export async function loadMcpInputs(app: App, toolsFolder: string): Promise<McpInputVariable[]> {
	const mcpPath = normalizePath(`${toolsFolder}/mcp.json`);
	const mcpFile = app.vault.getAbstractFileByPath(mcpPath);
	if (!mcpFile || !(mcpFile instanceof TFile)) return [];

	try {
		const content = await app.vault.read(mcpFile);
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object') return [];
		return parseMcpInputs(parsed);
	} catch {
		return [];
	}
}

/** Extract McpInputVariable[] from parsed mcp.json. */
function parseMcpInputs(parsed: Record<string, unknown>): McpInputVariable[] {
	const rawInputs = parsed['inputs'];
	if (!Array.isArray(rawInputs)) return [];
	const inputs: McpInputVariable[] = [];
	for (const item of rawInputs) {
		if (item && typeof item === 'object' && 'id' in item && 'description' in item) {
			const obj = item as Record<string, unknown>;
			inputs.push({
				type: typeof obj['type'] === 'string' ? obj['type'] : 'promptString',
				id: String(obj['id']),
				description: String(obj['description']),
				password: obj['password'] === true || obj['password'] === 'true',
			});
		}
	}
	return inputs;
}

/** Regex matching ${input:variableId} placeholders. */
const INPUT_VAR_RE = /\$\{input:([^}]+)\}/g;

/**
 * Recursively resolve ${input:...} placeholders in a value.
 * Returns the resolved string, or the original if no placeholders found.
 */
function resolveInputPlaceholders(value: string, valueMap: ReadonlyMap<string, string>): string {
	return value.replace(INPUT_VAR_RE, (match, id: string) => {
		const resolved = valueMap.get(id);
		return resolved !== undefined ? resolved : match;
	});
}

/**
 * Resolve all ${input:...} placeholders in a server config object (env, headers, url, etc.).
 * Mutates a deep copy of the config.
 */
function resolveConfigInputs(config: Record<string, unknown>, valueMap: ReadonlyMap<string, string>): Record<string, unknown> {
	const resolved: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(config)) {
		if (typeof val === 'string') {
			resolved[key] = resolveInputPlaceholders(val, valueMap);
		} else if (val && typeof val === 'object' && !Array.isArray(val)) {
			resolved[key] = resolveConfigInputs(val as Record<string, unknown>, valueMap);
		} else if (Array.isArray(val)) {
			resolved[key] = val.map(item => typeof item === 'string' ? resolveInputPlaceholders(item, valueMap) : item);
		} else {
			resolved[key] = val;
		}
	}
	return resolved;
}

/** Callback to resolve a missing input variable value. Return undefined to skip. */
export type InputResolver = (input: McpInputVariable) => Promise<string | undefined>;

/**
 * Load agency configuration from agency.md in the tools folder.
 * The file uses YAML frontmatter to control which agency services
 * are shown and which are enabled by default.
 *
 * Example agency.md:
 * ```
 * ---
 * services:
 *   - mail
 *   - calendar
 *   - teams
 * enabled:
 *   - mail
 * ---
 * Optional notes about your agency setup.
 * ```
 */
export async function loadAgencyConfig(app: App, toolsFolder: string): Promise<AgencyConfig> {
	const filePath = normalizePath(`${toolsFolder}/agency.md`);
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!file || !(file instanceof TFile)) return {};

	try {
		const content = await app.vault.read(file);
		const {meta} = parseFrontmatter(content);

		const toArray = (val: string | string[] | undefined): string[] | undefined => {
			if (!val) return undefined;
			if (Array.isArray(val)) return val.length > 0 ? val : undefined;
			return val.length > 0 ? [val] : undefined;
		};

		return {
			services: toArray(meta['services']),
			enabled: toArray(meta['enabled']),
		};
	} catch (e) {
		console.error('Sidekick: failed to parse agency.md', e);
		return {};
	}
}

/**
 * Load MCP server entries from mcp.json in the given vault tools folder.
 * Supports both { "servers": { ... } } and { "mcpServers": { ... } } formats.
 * When a resolveInput callback is provided, ${input:...} placeholders in server
 * configs are resolved using stored values or by prompting the user.
 */
export async function loadMcpServers(
	app: App,
	toolsFolder: string,
	resolveInput?: InputResolver,
): Promise<McpServerEntry[]> {
	const mcpPath = normalizePath(`${toolsFolder}/mcp.json`);
	const entries: McpServerEntry[] = [];
	const mcpFile = app.vault.getAbstractFileByPath(mcpPath);
	if (!mcpFile || !(mcpFile instanceof TFile)) return entries;

	try {
		const content = await app.vault.read(mcpFile);
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object') return entries;

		// Parse input definitions
		const inputs = parseMcpInputs(parsed);

		// Build value map for all inputs
		const valueMap = new Map<string, string>();
		if (resolveInput && inputs.length > 0) {
			for (const input of inputs) {
				const value = await resolveInput(input);
				if (value !== undefined) {
					valueMap.set(input.id, value);
				}
			}
		}

		// Accept both "servers" and "mcpServers" keys
		const serversObj =
			(parsed['servers'] as Record<string, unknown> | undefined) ??
			(parsed['mcpServers'] as Record<string, unknown> | undefined);

		if (serversObj && typeof serversObj === 'object') {
			for (const [name, config] of Object.entries(serversObj)) {
				if (config && typeof config === 'object') {
					const resolvedConfig = valueMap.size > 0
						? resolveConfigInputs(config as Record<string, unknown>, valueMap)
						: config as Record<string, unknown>;
					// Parse optional auth refresh config
					const rawAuth = (config as Record<string, unknown>)['auth'];
					let auth: McpAuthConfig | undefined;
					if (rawAuth && typeof rawAuth === 'object' && typeof (rawAuth as Record<string, unknown>)['command'] === 'string') {
						const a = rawAuth as Record<string, unknown>;
						auth = {
							command: a['command'] as string,
							...(Array.isArray(a['args']) ? {args: a['args'] as string[]} : {}),
							...(typeof a['setInput'] === 'string' ? {setInput: a['setInput']} : {}),
						};
					}
					entries.push({name, config: resolvedConfig, ...(auth ? {auth} : {})});
				}
			}
		}
	} catch (e) {
		console.error('Sidekick: failed to parse mcp.json', e);
	}
	return entries;
}

/**
 * Load all instruction files (*.instructions.md) from the given vault folder.
 * Returns concatenated instruction text to be prepended to every session system message.
 */
export async function loadInstructions(app: App, sidekickFolder: string): Promise<string> {
	const folder = normalizePath(sidekickFolder);
	const abstract = app.vault.getAbstractFileByPath(folder);
	if (!(abstract instanceof TFolder)) return '';

	const instructionFiles = abstract.children.filter(
		(child): child is TFile => child instanceof TFile && child.extension === 'md' && child.name.endsWith('.instructions.md')
	);
	if (instructionFiles.length === 0) return '';

	// Sort by name for deterministic order
	instructionFiles.sort((a, b) => a.name.localeCompare(b.name));
	const contents = await Promise.all(instructionFiles.map(f => app.vault.read(f)));

	const parts: string[] = [];
	for (let i = 0; i < instructionFiles.length; i++) {
		const body = contents[i]!.trim();
		if (body) parts.push(body);
	}
	return parts.join('\n\n');
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

		const id = child.basename.replace('.trigger', '');

		triggers.push({
			name: (typeof meta['name'] === 'string' && meta['name']) || id,
			description: (typeof meta['description'] === 'string' && meta['description']) || undefined,
			agent: (typeof meta['agent'] === 'string' && meta['agent']) || undefined,
			model: (typeof meta['model'] === 'string' && meta['model']) || undefined,
			enabled: String(meta['enabled']).toLowerCase() !== 'false',
			cron: (typeof meta['cron'] === 'string' && meta['cron']) || undefined,
			glob: (typeof meta['glob'] === 'string' && meta['glob']) || undefined,
			icon: (typeof meta['icon'] === 'string' && meta['icon']) || undefined,
			content: body,
			filePath: child.path,
		});
	}
	return triggers;
}
