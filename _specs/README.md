# Sidekick Context Intelligence — Spec Index

Branch: `feature/context-intelligence`
Parent: `main`

## Overview

This branch introduces a **local intelligence layer** to Sidekick, addressing the gap
identified in the architecture analysis: all vault context currently flows raw to the
LLM with no local indexing, pre-filtering, caching, or structure awareness.

The work is split into six specs (P1–P6), ordered by effort/impact ratio.
Each spec is self-contained and can be merged independently, though later specs build
on earlier ones where noted.

## Specs

| # | Spec | Priority | Effort | Impact | New Files | Modified Files |
|---|------|----------|--------|--------|-----------|----------------|
| 1 | [Smart ghost-text truncation](./01-smart-ghost-truncation.md) | P1 | Low | Medium | — | `ghostText.ts` |
| 2 | [Search result cache](./02-search-result-cache.md) | P2 | Low | High | — | `sidekickView.ts` |
| 3 | [Metadata pre-filter for search](./03-metadata-prefilter.md) | P3 | Medium | High | `vaultIndex.ts` | `sidekickView.ts`, `types.ts` |
| 4 | [Context builder + document graph](./04-context-builder.md) | P4 | High | High | `contextBuilder.ts` | `sidekickView.ts`, `ghostText.ts`, `types.ts` |
| 5 | [Trigger diff context](./05-trigger-diff-context.md) | P5 | Medium | Medium | — | `triggerScheduler.ts`, `sidekickView.ts` |
| 6 | [Demand-driven orchestration](./06-demand-driven-orchestration.md) | P6 | High | High | — | `sidekickView.ts`, `contextBuilder.ts`, `types.ts`, `settings.ts`, `styles.css` |
| 7 | [SidekickView decomposition + customAgents](./07-sidekick-view-decomposition.md) | P1 | High | High | 8 new `view/` modules | `sidekickView.ts`, `view/sessionConfig.ts`, `view/inputArea.ts`, `view/chatRenderer.ts`, `telegramBot.ts` |

## Dependency Graph

```
P1 (Ghost text)     ← standalone, no deps
P2 (Search cache)   ← standalone, no deps
P3 (Metadata)       ← standalone (introduces vaultIndex.ts)
P4 (Context builder)← depends on P3 (uses VaultIndex)
P5 (Trigger diff)   ← standalone, optionally uses P3's VaultIndex for backlinks
P6 (Demand-driven)  ← depends on P3 + P4 (uses VaultIndex + ContextBuilder for 'auto' fallback)
P1 (View decomp)   ← standalone (refactor only, no new features — reduces merge-conflict surface)
```

## Design Principles

1. **Use Obsidian's `app.metadataCache`** — it already provides frontmatter, headings,
   links, tags, and sections. Zero indexing overhead.
2. **No new dependencies** — P1–P3 and P5 add zero npm packages. P4 is the only spec
   that may optionally add `fuse.js` (~7KB gzipped) for local fuzzy search.
3. **Lazy initialization** — nothing runs at startup. Indices are built on first use
   and incrementally updated via `metadataCache.on('changed')`.
4. **Backwards compatible** — all changes are additive. Existing behavior is preserved
   when the new features are disabled or the index is empty.
5. **Keep `main.ts` untouched** — all new code goes into dedicated modules or existing
   feature files.

## Branch Setup

```bash
git checkout main
git pull origin main
git checkout -b feature/context-intelligence
```

## Testing Strategy

Each spec includes its own acceptance criteria. Manual testing workflow:

```bash
npm run build
# Copy main.js + manifest.json to vault plugin folder
obsidian plugin:reload id=sidekick
```

Automated verification is not feasible in the Obsidian plugin sandbox; each spec
defines observable behaviors to verify manually.
