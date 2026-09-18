# Agent workflow

## Serena-first repository navigation

When Serena MCP tools are available, use them as the primary way to understand and edit this repository.

- Activate the current repository with Serena before substantial code work.
- Prefer symbol-oriented tools such as `get_symbols_overview`, `find_symbol`, and `find_referencing_symbols` over reading entire files.
- Read full files only when symbol-level retrieval is insufficient.
- Prefer targeted symbol edits over whole-file rewrites.
- Respect `.serena/project.yml` ignored paths and project settings.
- Preserve the existing architecture and interfaces unless the task requires a change.
- Before considering a task complete, run the relevant tests, lint, build, or validation commands when available.
- If Serena is unavailable, fall back to the smallest possible Git/GitHub/code search scope instead of scanning the whole repository.
