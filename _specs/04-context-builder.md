# Spec 04 — Context Builder + Document Graph

**Priority:** P4 (High effort, High impact)
**Files modified:** `src/sidekickView.ts`, `src/ghostText.ts`, `src/types.ts`
**New files:** `src/contextBuilder.ts`
**Dependencies:** P3 (`VaultIndex` from `vaultIndex.ts`)

---

## Problem

Every chat message re-sends the entire vault scope as raw directory attachments.
The plugin has no awareness of document relationships (links, backlinks, tags),
no relevance filtering, and no differential context across conversation turns.

### Current Implementation

```
buildSdkAttachments() — sidekickView.ts line 4536:
  For each attachment:   → Send full file (absolute path)
  For each scope path:   → Send full directory (absolute path)
  → SDK reads everything, truncates invisibly

buildPrompt() — sidekickView.ts line 4504:
  → Inline clipboard text
  → Inline selection text
  → Append cursor position
  → No relevance filtering, no metadata context

fireTriggerInBackground() — sidekickView.ts line 3605:
  → prompt = "[File changed: path]\n\n" + trigger.content
  → No file content, no diff, no related files, no scope
```

---

## Design

### New Module: `src/contextBuilder.ts`

Provides query-aware context assembly using the document graph from
`VaultIndex` (Spec 03).

```typescript
import { App, TFile } from 'obsidian';
import { VaultIndex, NoteMetadata } from './vaultIndex';

export interface ContextOptions {
  /** User query / prompt to optimize context for */
  query: string;
  /** Scope paths to search within */
  scopePaths: string[];
  /** Maximum total characters for context */
  maxChars?: number;         // default: 8000
  /** Maximum number of files to include */
  maxFiles?: number;         // default: 15
  /** Maximum chars per file excerpt */
  maxPerFile?: number;       // default: 500
  /** Paths already in the session context (skip these) */
  alreadySent?: Set<string>;
}

export interface ContextResult {
  /** Files selected as relevant, with excerpts */
  files: ContextFile[];
  /** Compact summary text to prepend to prompt */
  summary: string;
  /** Paths included (for tracking across turns) */
  includedPaths: Set<string>;
  /** Total character count of context */
  totalChars: number;
}

export interface ContextFile {
  path: string;
  excerpt: string;      // truncated content (~maxPerFile chars)
  reason: string;       // why it was included
  score: number;
}

export class ContextBuilder {
  constructor(
    private app: App,
    private vaultIndex: VaultIndex,
  ) {}

  /**
   * Build optimized context for a query.
   * Uses metadata scoring + graph traversal to select relevant files,
   * reads only those files, and produces compact excerpts.
   */
  async buildContext(options: ContextOptions): Promise<ContextResult> { ... }

  /**
   * Build context for a file-change trigger.
   * Includes: changed file content, graph neighbors, folder siblings.
   */
  async buildTriggerContext(
    changedPath: string,
    triggerContent: string,
    options?: Partial<ContextOptions>,
  ): Promise<ContextResult> { ... }

  /**
   * Build context for ghost-text completion.
   * Includes: current file metadata, linked file summaries.
   */
  buildGhostContext(
    currentFile: TFile,
    cursorLine: number,
  ): string { ... }
}
```

### Context Building Algorithm

```typescript
async buildContext(options: ContextOptions): Promise<ContextResult> {
  const {
    query,
    scopePaths,
    maxChars = 8000,
    maxFiles = 15,
    maxPerFile = 500,
    alreadySent = new Set(),
  } = options;

  // Phase 1: Score candidates using VaultIndex pre-filter
  const candidates = this.vaultIndex.preFilter(query, scopePaths, maxFiles * 3);

  // Phase 2: Boost graph-connected files
  //   If the user attached specific files, boost files that link to/from them
  //   If the query mentions a known file name, boost its graph neighbors
  const boosted = this.applyGraphBoost(candidates, query, alreadySent);

  // Phase 3: Filter out already-sent files
  const fresh = boosted.filter(c => !alreadySent.has(c.note.path));

  // Phase 4: Token budget allocation
  //   Top N files by score, fitted within maxChars
  const selected = this.fitBudget(fresh, maxFiles, maxChars, maxPerFile);

  // Phase 5: Read selected files and produce excerpts
  const files: ContextFile[] = [];
  let totalChars = 0;

  for (const candidate of selected) {
    const file = this.app.vault.getAbstractFileByPath(candidate.note.path);
    if (!(file instanceof TFile)) continue;

    const content = await this.app.vault.cachedRead(file);
    const excerpt = this.extractRelevantExcerpt(content, query, maxPerFile);

    files.push({
      path: candidate.note.path,
      excerpt,
      reason: candidate.matchReasons.join(', '),
      score: candidate.score,
    });
    totalChars += excerpt.length;
  }

  // Phase 6: Build compact summary
  const summary = this.buildSummary(files, query);
  const includedPaths = new Set(files.map(f => f.path));

  return { files, summary, includedPaths, totalChars };
}
```

### Graph Boost

```typescript
private applyGraphBoost(
  candidates: SearchCandidate[],
  query: string,
  alreadySent: Set<string>,
): SearchCandidate[] {
  // Identify anchor files: files already in context or explicitly mentioned
  const anchors = new Set<string>();
  for (const path of alreadySent) anchors.add(path);

  // Also check if query mentions a known filename
  const allFiles = this.app.vault.getMarkdownFiles();
  for (const f of allFiles) {
    const name = f.basename.toLowerCase();
    if (query.toLowerCase().includes(name) && name.length > 3) {
      anchors.add(f.path);
    }
  }

  if (anchors.size === 0) return candidates;

  // Boost candidates that are linked to/from anchor files
  const anchorLinks = new Set<string>();
  for (const anchor of anchors) {
    const linked = this.vaultIndex.getLinkedFiles(anchor);
    for (const p of linked.forward) anchorLinks.add(p);
    for (const p of linked.backward) anchorLinks.add(p);
  }

  return candidates.map(c => ({
    ...c,
    score: anchorLinks.has(c.note.path) ? c.score + 3 : c.score,
    matchReasons: anchorLinks.has(c.note.path)
      ? [...c.matchReasons, 'graph-linked']
      : c.matchReasons,
  })).sort((a, b) => b.score - a.score);
}
```

### Excerpt Extraction

```typescript
private extractRelevantExcerpt(
  content: string,
  query: string,
  maxChars: number,
): string {
  // If content fits, return as-is
  if (content.length <= maxChars) return content;

  // Try to find query terms in content and center excerpt around them
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const contentLower = content.toLowerCase();

  let bestIdx = 0;
  let bestScore = 0;
  for (const term of queryTerms) {
    const idx = contentLower.indexOf(term);
    if (idx >= 0) {
      bestIdx = idx;
      bestScore++;
    }
  }

  if (bestScore > 0) {
    // Center excerpt around the first match
    const start = Math.max(0, bestIdx - maxChars / 3);
    const end = Math.min(content.length, start + maxChars);
    const raw = content.slice(start, end);

    // Clean break at paragraph boundary
    const firstBreak = start > 0 ? raw.indexOf('\n') : 0;
    const lastBreak = end < content.length ? raw.lastIndexOf('\n') : raw.length;
    return raw.slice(
      firstBreak > 0 ? firstBreak + 1 : 0,
      lastBreak > 0 ? lastBreak : raw.length,
    );
  }

  // No match — return first maxChars (frontmatter + intro)
  const cut = content.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > maxChars * 0.75 ? cut.slice(0, lastBreak) : cut;
}
```

### Summary Builder

```typescript
private buildSummary(files: ContextFile[], query: string): string {
  if (files.length === 0) return '';

  const lines = [
    `Context: ${files.length} relevant files for "${query}":`,
    ...files.map(f =>
      `- ${f.path} (${f.reason})`
    ),
    '',
  ];
  return lines.join('\n');
}
```

### Ghost-Text Context

Extends Spec 01's header with linked-file awareness:

```typescript
buildGhostContext(currentFile: TFile, cursorLine: number): string {
  const metadata = this.vaultIndex.getNoteMetadata(currentFile);
  const parts: string[] = [];

  // Linked files — 1-line summaries
  const linked = this.vaultIndex.getLinkedFiles(currentFile.path);
  if (linked.forward.length > 0) {
    const summaries = linked.forward.slice(0, 3).map(path => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return null;
      const meta = this.vaultIndex.getNoteMetadata(f);
      return `${meta.name} (${meta.tags.slice(0, 3).join(', ')})`;
    }).filter(Boolean);

    if (summaries.length > 0) {
      parts.push(`Linked: ${summaries.join('; ')}`);
    }
  }

  return parts.length > 0 ? parts.join(' | ') + '\n' : '';
}
```

---

## Integration Points

### Chat Messages (`sidekickView.ts`)

```typescript
// In handleSend(), before session.send():

// Build optimized context
const context = await this.contextBuilder.buildContext({
  query: sendPrompt,
  scopePaths: this.scopePaths,
  maxChars: 8000,
  alreadySent: this.sessionContextPaths, // track across turns
});

// Merge into prompt
const contextualPrompt = context.summary + '\n\n' + fullPrompt;

// Update session context tracking
for (const p of context.includedPaths) {
  this.sessionContextPaths.add(p);
}

// Include excerpts as inline context (not directory attachments)
const excerptBlock = context.files.map(f =>
  `--- ${f.path} ---\n${f.excerpt}`
).join('\n\n');

if (excerptBlock) {
  contextualPrompt = context.summary + '\n\n' + excerptBlock + '\n\n' + fullPrompt;
}
```

### Session Context Tracking

```typescript
// New class property:
private sessionContextPaths = new Set<string>();

// Reset on new session:
// In ensureSession() or when currentSessionId changes:
this.sessionContextPaths.clear();
```

### Ghost Text (`ghostText.ts`)

In `buildPrompt()`, after the Spec 01 context header:

```typescript
// Add linked-file context from ContextBuilder
if (plugin.contextBuilder) {
  const ghostCtx = plugin.contextBuilder.buildGhostContext(activeFile, cursorLine);
  header += ghostCtx;
}
```

---

## Changes

### New: `src/contextBuilder.ts`

| Export | Purpose |
|--------|---------|
| `ContextBuilder` class | Query-aware context assembly |
| `ContextOptions` interface | Configuration for context building |
| `ContextResult` interface | Return value with files, summary, tracking info |
| `ContextFile` interface | Single file entry with excerpt and score |

### `src/sidekickView.ts`

| Location | Change |
|----------|--------|
| Imports | Add `import { ContextBuilder } from './contextBuilder'` |
| Class properties | Add `contextBuilder: ContextBuilder`, `sessionContextPaths: Set<string>` |
| `onOpen()` | Initialize `this.contextBuilder = new ContextBuilder(this.app, this.vaultIndex)` |
| `handleSend()` | Use `contextBuilder.buildContext()` to build optimized context |
| `ensureSession()` / session switch | Reset `sessionContextPaths` |
| `fireTriggerInBackground()` | Use `contextBuilder.buildTriggerContext()` — see Spec 05 |

### `src/ghostText.ts`

| Location | Change |
|----------|--------|
| `buildPrompt()` | Add linked-file context via `plugin.contextBuilder.buildGhostContext()` |

### `src/types.ts`

No changes — all new types are defined in `contextBuilder.ts`.

---

## Acceptance Criteria

1. Chat messages include a context summary showing which files were selected and why
2. Files already sent in the current session are not re-sent on subsequent messages
3. Files linked to/from explicitly attached files get a score boost
4. Excerpts are centered around query-relevant sections, not random truncation
5. Ghost text includes 1-line summaries of linked files in the context header
6. Total context stays within the configured `maxChars` budget (default 8000)
7. The context builder adds zero latency when scope is empty or vault is small
   (lazy reads — no upfront file scanning)

## Non-Goals

- Full-text search or TF-IDF weighting (deferred to P6)
- In-memory embedding index
- Modifying the Copilot SDK's internal context handling
- Changing session configuration schema
