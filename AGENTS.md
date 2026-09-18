# Repository agent instructions

This repository adopts shared standards from `dbrckk/repo-standards` at the release recorded in `.repo-standards.yml`.

Before substantial work:
1. Read the central `AGENTS.md` and relevant files under `standards/` at the configured standards ref.
2. Read `.ai/project-state.md`.
3. Read `.ai/change-impact.md`.
4. Read `.ai/architecture.json`.
5. Read `.ai/dependency-map.json` when changes may cross module/package boundaries.
6. Read `.ai/commands.json`.
7. Read `.ai/ci-status.md`.
8. Read `.ai/security-signals.json` for release/security-sensitive work.
9. Read `.ai/repo-health.md`.
10. Read `.ai/index.md`.
11. Prefer the relevant file under `.ai/maps/` when present.
12. Read `.ai/repo-map.md` only when the smaller context is insufficient.
13. Fetch only task-relevant source files or symbols.

Repository-specific rules:
- Preserve the existing architecture and public interfaces unless the task requires a change.
- Prefer the smallest coherent change.
- Run the relevant tests, lint, build, or validation commands before declaring completion.
- Treat commands in `.ai/commands.json` as detected candidates; verify them when confidence is not high.
- Treat `.ai/security-signals.json` as heuristic evidence, never proof of a secret leak.
- Never reproduce suspected secret values.
- Update the manual parts of `.ai/project-state.md` when status, blockers, or next priority materially changes.
