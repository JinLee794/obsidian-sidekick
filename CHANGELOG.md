# Changelog

All notable changes to the Sidekick plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.1] - 2026-03-13

### Fixed
- Linting issues

### Changed
- Updated README with table of contents, CLI tools, and enhanced bot configuration details

## [1.2.0] - 2026-03-13

### Added
- Telegram bot integration with configuration and message handling

### Changed
- Refactored code for improved modularity
- Updated warning message text for consistency in settings

## [1.1.0] - 2026-03-12

### Added
- Settings tab UI enhancements

### Changed
- Reorganized README sections for clarity and removed redundant preview content

## [1.0.1] - 2026-03-10

### Fixed
- Linting issues and updated dependencies

## [1.0.0] - 2026-03-10

### Added
- EditModal for advanced text editing with AI and shared task definitions
- ESLint configuration with custom rules for UI text formatting

### Fixed
- Placeholder text for consistency and clarity across modals and settings
- Regex for directory traversal validation in file paths
- Manifest description for clarity

### Changed
- UI text to use sentence case for consistency across notices
- Streamlined debug logging and improved type handling
- Stricter TypeScript configuration for better error handling

## [0.6.0] - 2026-03-03

### Changed
- Plugin guidelines fixes
- Updated manifest with detailed description and author information

## [0.5.0] - 2026-03-03

### Added
- Ghost-text autocomplete feature with gutter indicator
- BYOK (Bring Your Own Key) support with enhanced provider configuration
- Apache License 2.0
- Remote connection support for CopilotService

### Changed
- Updated README to clarify desktop requirements
- Improved installation instructions and CLI verification steps

## [0.1.0] - 2026-02-27

### Added
- Initial release
- Sidekick chat view with folder picker and message metadata display
- Collapsible tool call blocks in chat view
- Tool approval modal and settings for tool invocation permissions
- Folder tree modal and attachment handling with absolute paths
- Editor context menu actions for text manipulation
- Active note tracking and display
- Session sidebar with session management
- Prompt management with loading, selection, and dropdown UI
- Trigger management system with cron and file change support
- Error handling for stale session in message sending
