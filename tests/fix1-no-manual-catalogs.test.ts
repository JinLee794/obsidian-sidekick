/**
 * Tests for Fix #1: System message no longer contains manual tool/skill catalogs.
 * Now tests the extracted buildSystemParts() directly.
 */
import {describe, it, expect} from 'vitest';
import {buildSystemParts} from '../src/view/sessionConfig';

describe('Fix #1: System message — no manual catalogs', () => {
	it('should NOT contain MCP tool catalog text', () => {
		const msg = buildSystemParts({
			globalInstructions: 'Be helpful.',
			hasMcpServers: true,
			contextMode: 'suggest',
			hasSkills: true,
			hasMcpTools: true,
		});
		expect(msg).toBeDefined();
		expect(msg).not.toContain('Available MCP tools');
		expect(msg).not.toContain('MCP server "');
	});

	it('should NOT contain skill catalog text', () => {
		const msg = buildSystemParts({
			globalInstructions: 'Be helpful.',
			hasMcpServers: true,
			contextMode: 'auto',
			hasSkills: true,
			hasMcpTools: false,
		});
		expect(msg).not.toContain('Available skills');
		expect(msg).not.toContain('IMPORTANT: When a request matches');
		expect(msg).not.toContain('ad-hoc tool operations');
	});

	it('should NOT contain "Prefer MCP tools over bash" coaching', () => {
		const msg = buildSystemParts({
			hasMcpServers: true,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: true,
		});
		expect(msg).not.toContain('Prefer MCP tools over bash');
	});

	it('should NOT contain subagent failure guidance', () => {
		const msg = buildSystemParts({
			globalInstructions: 'Be helpful.',
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(msg ?? '').not.toContain('subagent fails');
		expect(msg ?? '').not.toContain('do not invoke the same subagent');
	});

	it('should include global instructions when present', () => {
		const msg = buildSystemParts({
			globalInstructions: 'Always respond in Portuguese.',
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(msg).toBe('Always respond in Portuguese.');
	});

	it('should include error hint when MCP servers present', () => {
		const msg = buildSystemParts({
			hasMcpServers: true,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(msg).toContain('tool call fails');
		expect(msg).toContain('report the error');
	});

	it('should include context mode guidance when mode is suggest', () => {
		const msg = buildSystemParts({
			hasMcpServers: false,
			contextMode: 'suggest',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(msg).toContain('on-demand file/search tools');
	});

	it('should return undefined when no parts apply', () => {
		const msg = buildSystemParts({
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: false,
			hasMcpTools: false,
		});
		expect(msg).toBeUndefined();
	});

	it('should include lightweight skill/tool hint when skills present', () => {
		const msg = buildSystemParts({
			hasMcpServers: false,
			contextMode: 'auto',
			hasSkills: true,
			hasMcpTools: false,
		});
		expect(msg).toContain('Skills and MCP tools are registered');
	});
});
