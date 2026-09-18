# Repository agent instructions

This repository adopts the shared standards from `dbrckk/repo-standards`.

Before substantial work:
1. Read the central `AGENTS.md` and relevant files under `standards/` in `dbrckk/repo-standards`.
2. Read `.ai/project-state.md`.
3. Read `.ai/repo-health.md`.
4. Read `.ai/repo-map.md`.
5. Fetch only the task-relevant source files or symbols.

Repository-specific rules:
- Preserve the existing architecture and public interfaces unless the task requires a change.
- Prefer the smallest coherent change.
- Run the relevant tests, lint, build, or validation commands before declaring completion.
- Update `.ai/project-state.md` when status, blockers, or next priority materially changes.
