import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
	},
	resolve: {
		alias: {
			// Stub out Obsidian and SDK imports that can't run outside the app
			'obsidian': './tests/__mocks__/obsidian.ts',
			'@github/copilot-sdk': './tests/__mocks__/copilot-sdk.ts',
		},
	},
});
