# Repository agent instructions

This repository adopts shared standards from `dbrckk/repo-standards` at the release recorded in `.repo-standards.yml`.

Before substantial work:
1. Read the central `AGENTS.md` and relevant standards at the configured ref.
2. Read `.ai/project-state.md`.
3. Read `.ai/brain/impact.json`.
4. Read `.ai/brain/selected-tests.json`.
5. Read `.ai/change-impact.md`.
6. Read `.ai/architecture.json`.
7. Read `.ai/brain/summary.md`, `.ai/brain/incremental-state.json`, and `.ai/brain/capabilities.json`.
8. If ast-grep enrichment is available, route named symbols through `.ai/brain/ast-routing.json` and one `.ai/brain/ast-symbols/<initial>.json` shard.
9. Fall back to `.ai/brain/lookup.json` when AST routing is unavailable or insufficient.
10. Use `.ai/brain/code-graph.json` and `.ai/brain/imports.json` for cross-module context.
11. Read `.ai/dependency-map.json` when dependency context matters.
12. Read `.ai/commands.json`, `.ai/ci-status.md`, and security signals when relevant.
13. Read `.ai/repo-health.md`.
14. Use `.ai/index.md` and segmented maps only if symbol-level context is insufficient.
15. Read `.ai/repo-map.md` only as a final broad-context fallback.
16. Fetch only task-relevant source files or line ranges.

Repository-specific rules:
- Preserve existing architecture and public interfaces unless the task requires a change.
- Prefer the smallest coherent change.
- Prefer targeted tests from `.ai/brain/selected-tests.json`; expand validation when impact is ambiguous or targeted tests fail.
- Verify impact edges and AST/Repo Brain symbol hits against authoritative source before editing.
- Treat security signals and static graph edges as heuristics, not proof.
- Never reproduce suspected secret values.
- Update manual project-state sections when status, blockers, or next priority materially changes.
