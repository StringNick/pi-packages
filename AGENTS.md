# AGENTS.md — Zrow fork of pi-packages

This is a **product fork** of `gotgenes/pi-packages`, maintained for Zrow (Pi-native
desktop app). It is NOT the upstream repo: upstream workflow docs (releases via
`gh workflow run`, `/ship`, `/retro`, issue triage, `.pi/` skills/prompts) do not
apply here. Do not follow the upstream `AGENTS.md` — this file replaces it.

## What Zrow uses

Exactly two packages, consumed via bun workspaces from the kyracode root:

- `packages/pi-subagents` (`@gotgenes/pi-subagents`) — durable child sessions,
  explore/worker/reviewer/oracle roster, steer/result lifecycle.
- `packages/pi-permission-system` (`@gotgenes/pi-permission-system`) — Core-owned
  permission evaluation, host policy, child-grant forwarding.

Everything else in this checkout (`pi-autoformat`, `pi-colgrep`, `pi-github-tools`,
`pi-nocd`, `pi-permission-model-judge`, `pi-session-tools`, `pi-subagents-worktrees`,
root `.pi/`, `docs/plans|retro|triage`, workflows, release scripts) is **not built,
not shipped, and must be ignored**. Do not read it for behavior, do not edit it,
do not "fix" it.

## Docs worth reading (in the two kept packages)

- `docs/host-integration.md` — the host seams, the only integration points:
  `@gotgenes/pi-subagents/host` (`registerSubagentHost`),
  `@gotgenes/pi-permission-system/host` (host policy, child evaluator). Fail-closed
  defaults. Read this before touching host wiring.
- `docs/architecture/` + `docs/decisions/` — current behavior and ADRs.
- `docs/configuration.md`, and in permission-system also `docs/subagent-integration.md`
  and `docs/session-approvals.md`.
- `docs/plans/`, `docs/retro/`, `comparison-with-upstream.md`,
  `opencode-compatibility.md` — working notes, not authority. Skip unless a decision
  record is explicitly needed, and never cite a plan Non-Goal as a boundary.

## Pi + Zrow notes (read before changing the kept packages)

- Zrow renders all approval/prompt UI in React (approval picker). The pi-tui
  components inside these packages (`permission-prompt-component`, transcript
  widgets) are **not mounted** — `@earendil-works/pi-tui` stays only as an npm
  dependency for rendering primitives the kept code imports. Do not wire pi-tui UI.
- Product customizations live on the `zrow` branch as regular commits on top of
  upstream history (storage paths, durable sessions, host policy hooks, roster).
- Manifest `version` fields track **upstream releases**, not fork state: two trees
  can share a version with different behavior. The fork state is identified by the
  git SHA (kyracode pins it via the submodule gitlink). Never infer fork content
  from a version number.
- `CHANGELOG.md` files are upstream history. Do not rewrite them as if cherry-picks
  were released upstream.

## Watching upstream (cherry-picks only)

- NEVER `merge upstream/main` — it drags in all 7 unused packages plus docs noise.
- Watch: `git fetch upstream`, inspect tags (`pi-subagents-v*`,
  `pi-permission-system-v*`), read the fix with `git show <sha> --stat`.
- Take only reviewed fix/test/refactor commits touching our two packages:
  `git cherry-pick -x <sha>` in dependency order (refactor prereqs first).
  Skip docs/retro/triage-only commits and `.pi/` skill edits. If a fix commit mixes
  code with doc hunks, check out the doc paths from HEAD and keep code only.
- A cherry-pick whose base predates a fork-side refactor of the same lines needs a
  manual keep-both resolution (fork behavior + upstream fix); run the package suite
  after each conflicted pick.
- Push the result to `origin zrow` (fast-forward only), then bump the gitlink in
  kyracode as its own commit.

## Working in this tree

- Package commands run with pnpm from the fork root, e.g.
  `pnpm --filter @gotgenes/pi-subagents run check|test|lint`.
- kyracode consumes the packages as source via bun workspaces; `dist/` and
  `node_modules/` are git-ignored build artifacts, never source of truth.
- Local visibility: this checkout may use sparse-checkout limited to the two kept
  packages. For a complex pick series touching shared root configs, temporarily
  disable it (`git sparse-checkout disable`) and re-enable after.
