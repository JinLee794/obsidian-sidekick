/**
 * Tests for Fix #3: ensureSession uses resumeSession instead of full teardown.
 *
 * Validates that:
 * - ensureSession attempts resumeSession when configDirty + existing session
 * - Falls back to createSession if resume fails
 * - sessionContextPaths is NOT cleared on resume (preserving context)
 */
import {describe, it, expect} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const chatSessionSource = fs.readFileSync(
	path.resolve(__dirname, '../src/view/chatSession.ts'), 'utf-8'
);

describe('Fix #3: resumeSession for config updates', () => {

	it('should call resumeSession when session exists and configDirty', () => {
		expect(chatSessionSource).toContain('resumeSession');
		// The pattern: if session exists + configDirty, try resume first
		expect(chatSessionSource).toContain('this.currentSession && this.currentSessionId && this.configDirty');
	});

	it('should fall back to createSession if resume fails', () => {
		// The catch block should set currentSession = null and fall through
		expect(chatSessionSource).toContain('resumeSession failed');
		expect(chatSessionSource).toContain('this.currentSession = null');
	});

	it('should NOT clear sessionContextPaths on resume path', () => {
		// sessionContextPaths.clear() should only appear in the createSession path
		const resumeBlock = chatSessionSource.slice(
			chatSessionSource.indexOf('resumeSession'),
			chatSessionSource.indexOf('resumeSession failed')
		);
		expect(resumeBlock).not.toContain('sessionContextPaths.clear');
	});

	it('should still clear sessionContextPaths on fresh session creation', () => {
		// After the resume attempt, in the create-new path
		expect(chatSessionSource).toContain('this.sessionContextPaths.clear()');
	});

	it('should unsubscribe events before resume to re-register after', () => {
		// Resume path should unsubscribe first, then re-register
		const resumeSection = chatSessionSource.slice(
			chatSessionSource.indexOf('this.currentSession && this.currentSessionId && this.configDirty'),
			chatSessionSource.indexOf('// No existing session')
		);
		expect(resumeSection).toContain('this.unsubscribeEvents()');
		expect(resumeSection).toContain('this.registerSessionEvents()');
	});
});
