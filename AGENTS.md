# Agent workflow

## Fast repository context

When `.ai/repo-map.md` exists, read it first for repository structure and the compact code map. Do not scan the whole repository before consulting this map.

After the map:
- Search or fetch only the files directly relevant to the task.
- Prefer exact symbols, filenames, references, diffs, and small line ranges.
- Re-read broader files only when targeted context is insufficient.
- Ignore generated/build/vendor/assets directories unless the task explicitly concerns them.
- Refresh assumptions against the current branch before editing.

## Serena when available

When Serena MCP tools are available, use them after the repo map for symbol/reference navigation (`get_symbols_overview`, `find_symbol`, `find_referencing_symbols`). Serena is optional; the GitHub-generated repo map is the portable default.

## Completion

Preserve the existing architecture and interfaces unless the task requires a change. Before considering a task complete, run the relevant tests, lint, build, or validation commands when available.
