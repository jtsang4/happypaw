---
name: codex-version-upgrade
description: >
  Use this skill whenever the user asks to upgrade, bump, pin, refresh, or verify the built-in
  Codex CLI version in this HappyPaw repository, including requests about pinned Codex releases,
  app-server protocol regeneration, Codex schema sync, container image refresh, or compatibility
  checks after a Codex upgrade. Trigger even if the user only says things like "upgrade Codex",
  "bump the internal codex version", "refresh the bundled codex", or "sync to the latest Codex
  release", because this repo has a specific pinned-Codex workflow that must be followed carefully.
---

# Codex Version Upgrade

Use this skill to upgrade the built-in Codex version in this repository safely and predictably.

This repo does not rely on an ambient global `codex` installation. It pins a specific Codex release
and threads that version through:

- host-mode managed binary download
- repo-managed pinned binary cache
- generated Codex App Server protocol artifacts
- agent-runner protocol mirror
- container image build

Because of that, a Codex upgrade is never just "change one version string and build". Treat it as a
small compatibility migration with required verification.

## What success looks like

A successful upgrade means all of the following are true:

- the pinned version is updated in the correct source-of-truth file
- the target release assets still match this repo's download assumptions
- protocol artifacts are regenerated from the new pinned Codex CLI
- the agent-runner mirror is resynced from the root-generated artifacts
- validation passes
- if protocol or runtime compatibility breaks, the necessary source fixes are made instead of being ignored

## Repository-specific source of truth

Start from `AGENTS.md`, then use these files as the main upgrade map:

- `config/codex-binary.json` — pinned version source of truth
- `scripts/pinned-codex-binary.mjs` — repo-managed pinned binary download logic
- `src/features/execution/codex-binary.ts` — host-mode pinned binary resolution
- `scripts/generate-codex-protocol-artifacts.mjs` — regenerates `generated/codex-app-server-protocol/`
- `container/build.sh` — passes pinned version into Docker build
- `container/Dockerfile` — container-side Codex download/extract logic
- `container/agent-runner/src/generated/codex-app-server-protocol/` — mirror only, never edit by hand

## When to use this skill

Use this skill when the user asks to:

- upgrade Codex to the latest version
- bump the pinned Codex version
- refresh bundled Codex binaries
- sync or regenerate Codex app-server protocol artifacts
- verify whether a newer Codex release is compatible with this repo
- diagnose breakage caused by a Codex version bump

Do not use this skill for model/provider configuration changes that do not alter the pinned Codex
CLI version.

## Core mindset

### 1. Upgrade the pinned runtime, not just the generated files

The version bump begins at `config/codex-binary.json`. Generated artifacts are a consequence of that
change, not the primary edit.

### 2. Regenerated protocol output may be enough, but do not assume it is

If the new protocol compiles and validators pass, no source fix may be needed. But if typechecking,
building, or runtime-facing code breaks, fix the affected source modules rather than pretending the
upgrade is complete.

Likely compatibility hot spots include:

- `container/agent-runner/src/codex-client.ts`
- `container/agent-runner/src/codex-runtime.ts`
- `container/agent-runner/src/stream-processor.ts`
- any code importing generated protocol types directly

### 3. Respect artifact ownership

- `generated/codex-app-server-protocol/` is the root source of truth for generated protocol artifacts
- `container/agent-runner/src/generated/codex-app-server-protocol/` is only a synced mirror
- never hand-edit generated files unless the task is explicitly about changing the generator itself

## Recommended workflow

### Step 1: Inspect the current pinned version and latest target release

Read:

- `config/codex-binary.json`
- `AGENTS.md` sections about Codex protocol artifacts

Then determine the target release. If the user asked for "latest", verify the latest stable release
from `openai/codex`.

Before changing files, confirm the release still looks compatible with this repo's assumptions:

- host assets like `codex-<target-triple>.tar.gz` still exist
- container npm assets like `codex-npm-linux-arm64-<version>.tgz` and `codex-npm-linux-x64-<version>.tgz` still exist
- release tag naming still matches the current `releaseTag` pattern

If asset naming changed, update the relevant download logic before proceeding:

- `scripts/pinned-codex-binary.mjs`
- `src/features/execution/codex-binary.ts`
- `container/Dockerfile`

### Step 2: Update the pinned version source of truth

Edit `config/codex-binary.json`.

Normally, only these fields should change:

- `version`
- `releaseTag`

Do not casually modify:

- `releaseRepo`
- `assetBasename`
- `repoCacheDir`
- `hostCacheDir`
- `containerExecutablePath`

### Step 3: Regenerate protocol artifacts

Run:

```bash
npm run generate:codex-protocol
make sync-types
npm run test:codex-protocol
```

Why:

- `generate:codex-protocol` regenerates `generated/codex-app-server-protocol/` using the pinned Codex CLI
- `make sync-types` mirrors those artifacts into `container/agent-runner/src/generated/...`
- `test:codex-protocol` verifies the generated root artifacts and the expected CLI output are aligned

### Step 4: Check whether source code needs compatibility fixes

Do not stop at regenerated artifacts.

Run validation and inspect failures. If type errors or build errors appear in runtime code, update the
source modules accordingly. Common reasons include:

- renamed or added protocol types
- request/notification shape changes
- enum or field changes in generated types
- semantic shifts in app-server events

Keep fixes focused on compatibility. Do not mix unrelated refactors into the upgrade.

### Step 5: Rebuild the container path

Because the container bundles a pinned Codex binary, rebuild the image:

```bash
./container/build.sh
```

This also validates that the container-side download and extraction logic still works for the target
release.

### Step 6: Run final validators

At minimum, run the validators most relevant to this repo's Codex upgrade path:

```bash
npm run test:codex-protocol
make typecheck
make format-check
npm --prefix container/agent-runner run build
./container/build.sh
```

Use additional targeted tests if the upgrade forced source changes in specific areas.

## Decision heuristics

### When the upgrade is probably straightforward

It is usually a straightforward bump if all of the following are true:

- release asset naming still matches current scripts
- protocol regeneration succeeds
- `test:codex-protocol` passes
- typecheck passes
- agent-runner build passes
- container build confirms the new CLI version

In that case, the diff may legitimately consist mostly of:

- `config/codex-binary.json`
- regenerated root protocol artifacts
- synced agent-runner mirror artifacts

### When the upgrade needs real source work

Expect source changes if any of these happen:

- generated protocol files introduce type errors in runtime code
- event handling code no longer matches generated shapes
- Docker build cannot fetch or extract the new release assets
- host download logic fails for the new naming scheme

When this happens, fix the source of incompatibility instead of reverting to a half-complete upgrade.

## Guardrails

- Never treat the mirror directory as the source of truth
- Never skip `npm run test:codex-protocol` after a protocol refresh
- Never claim the upgrade is done based only on artifact generation
- Never ignore validator failures just because the generated diff "looks normal"
- Never update unrelated product behavior while doing a Codex bump

## Final report expectations

When using this skill, summarize:

1. the old and new pinned Codex versions
2. whether release asset assumptions still held or required code changes
3. whether source compatibility fixes were needed beyond regenerated artifacts
4. which validators were run and their outcomes

Keep the report concrete and repository-specific.
