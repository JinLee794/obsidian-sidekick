/**
 * Tests for shared session config utilities: buildExcludedTools, buildSystemParts.
 * These are pure functions extracted to eliminate duplication between
 * chat mode (sessionConfig.ts) and search mode (searchPanel.ts).
 */
import {describe, it, expect} from 'vitest';
import {buildExcludedTools, buildSystemParts} from '../src/view/sessionConfig';
import type {AgentConfig} from '../src/types';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: 'test-agent',
		description: 'Test',
		instructions: 'Do stuff.',
		filePath: 'agents/test.agent.md',
		...overrides,
	};
}

describe('buildExcludedTools', () => {
	it('should exclude all shell tools when alwaysExcludeShell is true', () => {
		const result = buildExcludedTools(undefined, true);
		expect(result).toContain('bash');
		expect(result).toContain('read_bash');
		expect(result).toContain('stop_bash');
		expect(result).toContain('write_bash');
		expect(result).toContain('list_bash');
	});

	it('should exclude shell tools when agent has no tools', () => {
		const agent = makeAgent();
		const result = buildExcludedTools(agent);
		expect(result).toContain('bash');
		expect(result).toContain('write_bash');
		expect(result).toContain('list_bash');
	});

	it('should NOT exclude bash when agent lists it', () => {
		const agent = makeAgent({tools: ['bash', 'm365']});
		const result = buildExcludedTools(agent);
		expect(result).not.toContain('bash');
		expect(result).not.toContain('read_bash');
		expect(result).not.toContain('stop_bash');
		// write_bash and list_bash NOT listed → still excluded
		expect(result).toContain('write_bash');
		expect(result).toContain('list_bash');
	});

	it('should NOT exclude write_bash when agent lists it', () => {
		const agent = makeAgent({tools: ['write_bash']});
		const result = buildExcludedTools(agent);
		expect(result).not.toContain('write_bash');
		expect(result).toContain('bash');
		expect(result).toContain('list_bash');
	});

	it('should merge agent excludeTools', () => {
		const agent = makeAgent({tools: ['bash'], excludeTools: ['exec_py', 'edit']});
		const result = buildExcludedTools(agent);
		expect(result).toContain('exec_py');
		expect(result).toContain('edit');
		expect(result).not.toContain('bash');
	});

	it('should not duplicate tools already in base exclusion', () => {
		const agent = makeAgent({excludeTools: ['bash', 'write_bash']});
		const result = buildExcludedTools(agent);
		const bashCount = result.filter(t => t === 'bash').length;
		expect(bashCount).toBe(1);
	});

	it('should handle no agent', () => {
		const result = buildExcludedTools(undefined);
		expect(result).toContain('bash');
		expect(result).toContain('write_bash');
		expect(result).toContain('list_bash');
	});

	it('alwaysExcludeShell should also merge agent excludeTools', () => {
		const agent = makeAgent({excludeTools: ['exec_py']});
		const result = buildExcludedTools(agent, true);
		expect(result).toContain('bash');
		expect(result).toContain('exec_py');
	});
});

describe('buildSystemParts', () => {
	it('should return undefined when no parts apply', () => {
		const result = buildSystemParts({
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(result).toBeUndefined();
	});

	it('should include global instructions when present', () => {
		const result = buildSystemParts({
			globalInstructions: 'Always respond in Portuguese.',
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(result).toBe('Always respond in Portuguese.');
	});

	it('should include agent instructions when present', () => {
		const result = buildSystemParts({
			agentInstructions: 'You are a researcher.',
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(result).toContain('You are a researcher.');
	});

	it('should include error hint when MCP servers present', () => {
		const result = buildSystemParts({
			hasMcpServers: true,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(result).toContain('tool call fails');
	});

	it('should include skill/tool awareness hint when skills or tools present', () => {
		const result = buildSystemParts({
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: true,
			hasMcpTools: false,
		});
		expect(result).toContain('Skills and MCP tools are registered');
	});

	it('should include context mode guidance in suggest mode', () => {
		const result = buildSystemParts({
			hasMcpServers: false,
			contextMode: 'suggest',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(result).toContain('on-demand file/search tools');
	});

	it('should combine all parts with double newline separator', () => {
		const result = buildSystemParts({
			globalInstructions: 'Part 1',
			agentInstructions: 'Part 2',
			hasMcpServers: true,
			contextMode: 'suggest',
			hasSkills: true,
			hasMcpTools: true,
		});
		const parts = result!.split('\n\n');
		expect(parts.length).toBeGreaterThanOrEqual(4);
		expect(parts[0]).toBe('Part 1');
		expect(parts[1]).toBe('Part 2');
	});

	it('should NOT contain former catalog text', () => {
		const result = buildSystemParts({
			globalInstructions: 'Be helpful.',
			hasMcpServers: true,
			contextMode: 'suggest',
			hasSkills: true,
			hasMcpTools: true,
		});
		expect(result).not.toContain('Available MCP tools');
		expect(result).not.toContain('Available skills');
		expect(result).not.toContain('Prefer MCP tools over bash');
		expect(result).not.toContain('IMPORTANT: When a request matches');
	});
});

describe('Source-level: search uses shared utilities', () => {
	it('searchPanel.ts imports buildExcludedTools and buildSystemParts', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(__dirname, '../src/view/searchPanel.ts'), 'utf-8'
		);
		expect(source).toContain('buildExcludedTools');
		expect(source).toContain('buildSystemParts');
		// Should NOT have inline shell tool exclusion
		expect(source).not.toContain("'bash', 'read_bash', 'write_bash', 'list_bash', 'stop_bash'");
	});

	it('sessionConfig.ts uses buildExcludedTools in buildSessionConfig', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const source = fs.readFileSync(
			path.resolve(__dirname, '../src/view/sessionConfig.ts'), 'utf-8'
		);
		expect(source).toContain('buildExcludedTools(selectedAgent)');
		// Should NOT have inline allowsBash logic
		expect(source).not.toContain('allowsBash');
		expect(source).not.toContain('allowsWriteBash');
		expect(source).not.toContain('allowsListBash');
	});
});
