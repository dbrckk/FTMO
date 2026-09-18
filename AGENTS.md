# Repository agent instructions

This repository adopts shared standards from `dbrckk/repo-standards` at the release recorded in `.repo-standards.yml`.

Before substantial work:
1. Read the central `AGENTS.md` and relevant standards at the configured ref.
2. Read `.ai/project-state.md`.
3. Read `.ai/change-impact.md`.
4. Read `.ai/architecture.json`.
5. Read `.ai/brain/summary.md`.
6. Search `.ai/brain/lookup.json` for named symbols before broad source exploration.
7. Use `.ai/brain/code-graph.json` and `.ai/brain/imports.json` for cross-module context.
8. Read `.ai/dependency-map.json` when dependency context matters.
9. Read `.ai/commands.json`, `.ai/ci-status.md`, and security signals when relevant.
10. Read `.ai/repo-health.md`.
11. Use `.ai/index.md` and segmented maps only if symbol-level context is insufficient.
12. Read `.ai/repo-map.md` only as a final broad-context fallback.
13. Fetch only task-relevant source files or line ranges.

Repository-specific rules:
- Preserve existing architecture and public interfaces unless the task requires a change.
- Prefer the smallest coherent change.
- Verify Repo Brain symbol hits against authoritative source before editing.
- Run relevant tests, lint, build, or validation commands before declaring completion.
- Treat security signals and static graph edges as heuristics, not proof.
- Never reproduce suspected secret values.
- Update manual project-state sections when status, blockers, or next priority materially changes.
