import tseslint from 'typescript-eslint';
import globals from "globals";
import { globalIgnores } from "eslint/config";
import { defineConfig } from "eslint/config";

export default tseslint.config(
	{
		rules: {
		"obsidianmd/ui/sentence-case": "off",
		},
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
