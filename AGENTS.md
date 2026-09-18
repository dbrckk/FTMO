# Repository agent instructions

This repository adopts shared standards from `dbrckk/repo-standards` at the release recorded in `.repo-standards.yml`.

Before substantial work:
1. Read the central `AGENTS.md` and relevant files under `standards/` at the configured standards ref.
2. Read `.ai/project-state.md`.
3. Read `.ai/change-impact.md`.
4. Read `.ai/architecture.json`.
5. Read `.ai/commands.json`.
6. Read `.ai/repo-health.md`.
7. Read `.ai/index.md`.
8. Prefer the relevant file under `.ai/maps/` when present.
9. Read `.ai/repo-map.md` only when the smaller context is insufficient.
10. Fetch only task-relevant source files or symbols.

Repository-specific rules:
- Preserve the existing architecture and public interfaces unless the task requires a change.
- Prefer the smallest coherent change.
- Run the relevant tests, lint, build, or validation commands before declaring completion.
- Treat commands in `.ai/commands.json` as detected candidates; verify them when confidence is not high.
- Update the manual parts of `.ai/project-state.md` when status, blockers, or next priority materially changes.
