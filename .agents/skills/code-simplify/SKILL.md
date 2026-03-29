---
name: code-simplify
description: >
  Use this skill whenever the user asks to simplify, refactor, clean up, reduce complexity, remove
  duplication, untangle logic, split large modules, clarify naming, improve maintainability, or make
  code easier for future coding agents to understand and change. Also trigger proactively when a
  coding task reveals incidental complexity that is blocking safe progress, even if the user did not
  explicitly ask for refactoring. This skill is for behavior-preserving or behavior-clarifying
  simplification in the current repository, but it should not treat the existing design as the ideal
  target: step back, evaluate what the best design for a coding agent would be, and then move the
  code toward that design with small, verifiable changes.
---

# Code Simplify

Use this skill to simplify and refactor code in this repository so it becomes easier to read, safer
to change, and friendlier for future coding agents.

This repository already has strong constraints and conventions, but existing code is not automatically
the best design. Treat the current implementation as evidence, not doctrine. First understand why it
looks the way it does, then decide whether that structure still earns its keep.

## What success looks like

Aim for code that is:

- easier to understand on first read
- organized around clear feature and module boundaries
- explicit about runtime constraints and isolation rules
- cheap to validate
- local in impact when changed
- friendly to future agents that need to continue the work

Good simplification usually reduces cognitive load more than it reduces line count.

## Repository-aware guardrails

Always preserve the high-level product and runtime constraints documented in `AGENTS.md`.

Especially important in this repo:

- Keep the project aligned with its current execution model. Do not reintroduce legacy compatibility
  layers, obsolete trigger-word architectures, or outdated abstractions.
- Respect session isolation, user isolation, IPC contracts, and container/host execution boundaries.
- Modify source files, not `dist/` or generated artifacts, unless the task is explicitly about generation.
- Treat `shared/stream-event.ts` as the stream-event source of truth.
- Prefer feature-local structure over dumping more logic into generic shared utilities.
- Keep file APIs, mount-security rules, auth boundaries, and path protections intact.

If a simplification would blur security or isolation boundaries, it is not a simplification.

## When to use this skill

Use this skill when any of these are true:

- the user asks to simplify, refactor, clean up, or restructure code
- a file or function is hard to reason about because it mixes unrelated responsibilities
- the same branching, normalization, validation, or persistence logic is duplicated in multiple places
- a compatibility layer, wrapper, or abstraction appears to exist mostly for historical reasons
- a planned change is risky because current code shape is too tangled
- naming or data flow makes correct edits harder than they should be
- a coding agent would likely need to re-read too much surrounding code just to make a safe change

Do not trigger this skill for purely cosmetic edits, speculative rewrites, or broad architecture
changes without a concrete payoff.

## Core mindset

### 1. Optimize for the next agent

Ask: if another coding agent opened this area tomorrow, what structure would let it succeed quickly
and safely?

Prefer designs that make these questions easy to answer:

- where does this behavior live?
- what are the inputs and outputs?
- what invariants matter here?
- what can be changed locally without hidden side effects?
- how should this area be validated?

### 2. Do not overfit to the current shape

Existing code can encode:

- real constraints worth preserving
- temporary workarounds
- migration leftovers
- accidental complexity
- outdated boundaries

Separate those cases deliberately. Reuse existing patterns when they are good. Replace them when they
make the system harder to understand or maintain.

### 3. Favor the smallest meaningful simplification

Do not jump straight to a large rewrite. Prefer a sequence of changes that each leave the codebase in
a clearly better state and can be validated independently.

## Simplification priorities

When choosing between possible refactors, prefer the option that best improves these qualities:

1. clear ownership of behavior
2. behavior preservation and easy verification
3. reduced branching and nesting
4. reduced duplication
5. explicit naming and data flow
6. smaller, single-purpose modules
7. boundaries that match the product and runtime model

## Recommended workflow

### Step 1: Reconstruct the intent before editing

Read the relevant code, call sites, nearby types, and tests first.

Determine:

- what behavior must remain unchanged
- what constraints come from this repo's architecture rather than local implementation taste
- where the real complexity comes from
- whether the current structure is carrying useful meaning or just historical weight

Do not start refactoring until you can explain the existing behavior in plain language.

### Step 2: Define the ideal target shape

Before touching code, briefly form a better design in your head.

For this repo, the ideal target often looks like:

- feature-local logic kept near the owning route/module
- shared code extracted only when it is truly reused and domain-neutral
- helpers with crisp inputs and outputs
- fewer giant "manager" or "utils" files
- route handlers that orchestrate rather than embed business logic
- runtime invariants enforced close to their boundary

Then compare the ideal shape with the current one and choose the smallest safe move toward it.

### Step 3: Pick the refactor type

Common good moves in this repo:

- extract a pure helper from a route or manager
- split a module by responsibility instead of by arbitrary size
- replace repeated conditionals with a named decision helper
- collapse pass-through abstractions that hide behavior instead of clarifying it
- move validation closer to input boundaries
- rename symbols so intent is obvious without tracing multiple files
- convert ad hoc data shaping into typed, reusable transformers

Common bad moves:

- introducing a new abstraction before proving repeated need
- creating a "common" or "misc" helper bucket
- moving logic across domains without a strong boundary reason
- changing behavior while claiming to only simplify
- preserving awkward architecture solely because it already exists

### Step 4: Keep the diff reviewable

Prefer refactors that are easy to inspect:

- isolate renames from logic changes when practical
- keep unrelated cleanup out of the same patch
- avoid large file moves unless they materially improve boundaries
- preserve stable interfaces unless changing them clearly simplifies the whole flow

### Step 5: Validate aggressively

Run the narrowest useful checks during iteration, then the required final validators for the affected
area before finishing.

For this repo, commonly relevant commands include:

```bash
make typecheck
npm run format:check
npm run build
npm --prefix container/agent-runner run build
node tests/<affected-test>.mjs
```

If you modify stream event types, also run:

```bash
make sync-types
```

## Decision heuristics

Use these heuristics to decide whether a refactor is worthwhile.

### Remove complexity when it does not buy anything important

Good candidates:

- duplicated parsing or validation logic
- deeply nested branching that can become guard clauses
- state being threaded through too many layers
- helper functions with vague names and too many call-site assumptions
- wrappers that only rename parameters or bounce data around
- compatibility code for removed product directions

### Keep complexity when it protects a real system constraint

Examples in this repo:

- user/session/container isolation
- secure file and mount handling
- queueing, retry, and message delivery guarantees
- request validation and auth boundaries
- IPC atomicity and cross-process coordination

If complexity exists to protect these invariants, simplify the presentation of the code without
weakening the protection.

## Refactoring patterns that usually help

### Extract decision points

When a function mixes orchestration and policy, pull the policy into a helper with a strong name.

### Flatten control flow

Prefer guard clauses and early returns over deeply nested success paths.

### Separate boundary handling from core logic

Parsing, auth checks, HTTP concerns, file-system guards, and IPC wiring should not obscure the
business rule being implemented.

### Replace vague names with intent-revealing names

If the reader has to inspect implementation to know what a symbol means, the name is not doing enough.

### Consolidate duplicated domain logic

Only extract duplication when the duplicated logic is genuinely the same concept, not just visually similar.

### Split oversized modules by responsibility

Split by ownership and behavior, not by arbitrary line counts.

## Agent-friendly output expectations

When you use this skill, your final report should briefly cover:

1. what complexity was removed
2. why the new structure is better for future changes
3. what invariants or behaviors were intentionally preserved
4. what validators were run

Keep the explanation concrete. Avoid vague claims like "cleaner" or "more maintainable" without naming
the actual simplification.

## Non-goals

This skill is not for:

- cosmetic formatting-only changes
- speculative framework migrations
- rewriting large stable areas without a clear maintenance benefit
- hiding complexity behind new abstractions instead of reducing it
- inventing architecture that conflicts with repository constraints

## Quick self-check before finishing

Before you stop, ask:

- Is the code actually simpler to reason about, or merely more abstract?
- Did I preserve behavior and critical invariants?
- Did I move the code closer to an ideal agent-friendly design?
- Is the change local, reviewable, and well-validated?
- Would another agent understand where to continue from here without rereading half the repo?

If any answer is "no", refine the refactor before concluding.
