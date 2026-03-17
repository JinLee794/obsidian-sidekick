# Spec 01 — Smart Ghost-Text Truncation

**Priority:** P1 (Low effort, Medium impact)
**Files modified:** `src/ghostText.ts`
**New files:** None
**Dependencies:** None

---

## Problem

Ghost-text autocomplete uses a fixed 30-line window around the cursor, hard-truncated
to 2000 characters with `slice()`. This causes:

1. **Mid-word/sentence cuts** — `before.slice(-1000)` can split inside a word
2. **Structure blindness** — truncation ignores heading boundaries, code blocks, list nesting
3. **No document awareness** — no frontmatter, no heading hierarchy, no file identity
4. **Single-file isolation** — no awareness of linked files

### Current Implementation

```
src/ghostText.ts, lines 27-40:

  CONTEXT_LINES = 30
  MAX_CONTEXT_CHARS = 2000

src/ghostText.ts, buildPrompt() ~line 315:

  startLine = max(1, currentLine - CONTEXT_LINES)
  endLine = min(totalLines, currentLine + CONTEXT_LINES)
  before = text from startLine to cursor
  after = text from cursor to endLine

  if (before.length + after.length > MAX_CONTEXT_CHARS) {
    before = before.slice(-1000)   // HARD CUT
    after = after.slice(0, 1000)   // HARD CUT
  }
```

---

## Design

### 1. Structure-Aware Truncation

Replace the `slice(-1000)` / `slice(0, 1000)` split with boundary-aware truncation:

```typescript
function truncateAtBoundary(text: string, maxChars: number, direction: 'before' | 'after'): string {
  if (text.length <= maxChars) return text;

  if (direction === 'before') {
    // Keep the LAST maxChars, but break at paragraph/sentence boundary
    const cut = text.slice(-maxChars);
    // Find first clean break: paragraph > heading > sentence > word
    const breaks = [
      cut.indexOf('\n\n'),         // paragraph
      cut.indexOf('\n#'),          // heading
      cut.search(/\.\s/),         // sentence
      cut.indexOf(' '),           // word
    ];
    const breakIdx = breaks.find(i => i > 0 && i < maxChars / 4);
    return breakIdx !== undefined ? cut.slice(breakIdx) : cut;
  } else {
    // Keep the FIRST maxChars, but break at paragraph/sentence boundary
    const cut = text.slice(0, maxChars);
    // Find last clean break
    const breaks = [
      cut.lastIndexOf('\n\n'),
      cut.lastIndexOf('\n#'),
      cut.search(/\.\s[^.]*$/),
      cut.lastIndexOf(' '),
    ];
    const breakIdx = breaks.find(i => i > maxChars * 3 / 4);
    return breakIdx !== undefined ? cut.slice(0, breakIdx) : cut;
  }
}
```

### 2. Frontmatter + Heading Context Header

Prepend a compact metadata header to the prompt so the LLM knows what document it's in
and where the cursor sits in the structure:

```typescript
function buildContextHeader(state: EditorState, plugin: SidekickPlugin): string {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) return '';

  const cache = plugin.app.metadataCache.getFileCache(file);
  if (!cache) return '';

  const parts: string[] = [];

  // File identity
  parts.push(`File: ${file.path}`);

  // Frontmatter tags/type (compact, one line)
  if (cache.frontmatter) {
    const tags = cache.frontmatter.tags;
    const type = cache.frontmatter.type;
    if (tags) parts.push(`Tags: ${Array.isArray(tags) ? tags.join(', ') : tags}`);
    if (type) parts.push(`Type: ${type}`);
  }

  // Current heading path (e.g., "# Project > ## Timeline > ### Q1")
  if (cache.headings?.length) {
    const cursorLine = state.doc.lineAt(state.selection.main.head).number;
    const headingPath = buildHeadingPath(cache.headings, cursorLine);
    if (headingPath) parts.push(`Section: ${headingPath}`);
  }

  return parts.length > 0 ? `[${parts.join(' | ')}]\n` : '';
}

function buildHeadingPath(headings: HeadingCache[], cursorLine: number): string {
  // Walk headings in order, maintain stack by level
  const stack: string[] = [];
  for (const h of headings) {
    if (h.position.start.line >= cursorLine) break;
    // Pop headings at same or deeper level
    while (stack.length >= h.level) stack.pop();
    stack.push(h.heading);
  }
  return stack.join(' > ');
}
```

### 3. Updated Constants

```typescript
// Increase max context now that truncation is smarter
const MAX_CONTEXT_CHARS = 3000;  // was 2000

// Character budget split: 60% before cursor, 40% after (cursor context matters more)
const BEFORE_RATIO = 0.6;
const AFTER_RATIO = 0.4;

// Header budget (reserved from total)
const HEADER_BUDGET = 200;
```

---

## Changes

### `src/ghostText.ts`

| Location | Change |
|----------|--------|
| Constants (lines 27-40) | Increase `MAX_CONTEXT_CHARS` to 3000; add `BEFORE_RATIO`, `AFTER_RATIO`, `HEADER_BUDGET` |
| `buildPrompt()` (~line 315) | Replace `slice()` calls with `truncateAtBoundary()` |
| New function | Add `truncateAtBoundary(text, maxChars, direction)` |
| New function | Add `buildContextHeader(state, plugin)` |
| New function | Add `buildHeadingPath(headings, cursorLine)` |
| `buildPrompt()` | Prepend `buildContextHeader()` output to prompt |
| Import | Add `import type { HeadingCache } from 'obsidian'` (if not already) |

### Prompt Format Change

Before:
```
Continue the text from exactly where it stops. Return ONLY the continuation...

TEXT BEFORE CURSOR:
{raw 1000 chars, possibly mid-word}
<<<CURSOR>>>
{raw 1000 chars, possibly mid-word}
```

After:
```
Continue the text from exactly where it stops. Return ONLY the continuation...

[File: projects/quarterly-review.md | Tags: #project, #review | Section: Project > Timeline > Q1]

TEXT BEFORE CURSOR:
{up to 1680 chars, broken at paragraph/sentence boundary}
<<<CURSOR>>>
{up to 1120 chars, broken at paragraph/sentence boundary}
```

---

## Acceptance Criteria

1. Ghost-text suggestions no longer produce completions that start mid-word due to
   truncated context
2. Completions in structured documents (lists, code blocks) maintain structural
   consistency
3. The heading path in the context header accurately reflects cursor position
4. No regression in suggestion latency (debounce remains 400ms)
5. Context stays within 3000 char budget

## Non-Goals

- Cross-file context for ghost text (deferred to P4)
- Changing the system prompt or model selection
- Adding new UI elements
