# DSH Step Risk Implementation Plan

> **For agentic workers:** This plan is executed inline in the current task. Steps use checkbox syntax for tracking.

**Goal:** Deliver and publish a GitHub-installable DeepSeek Harness bundle that updates an experimental, architecture-aware Bayesian attribution estimate after each step without replay or a fixed trace length.

**Architecture:** A dependency-free Cordis event observer converts committed Harness events to compact step features. A pure JavaScript Bayesian tracker splits unknown-future probability mass at each new step, updates candidate weights from explicit evidence, and reports current and historical candidates. The bundle logs only metadata and can optionally persist JSONL.

**Tech Stack:** Node.js ESM, built-in node:test, Cordis bundle manifest and patch, GitHub repository calledice/dsh-step-risk (proposed name).

## Global Constraints

- Probability target and caveat are defined in docs/PRODUCT_SPEC.md.
- No replay; no prompt, tool argument, or model output mutation.
- Unknown number of steps; no fixed sequence-size parameter.
- No raw GFA traces or credentials in the public repository or prediction logs.
- Compatibility target: DeepSeek Harness 0.2.1-alpha.1, source commit 5badb15009ae1756c3afe0ae0cef1faafc290ccc.

---

## Files and responsibilities

- package.json, cordis.patch.yml: installable DSH bundle contract.
- index.js: Cordis event integration, validation, and output routing.
- src/tracker.js: pure per-session Bayesian state transitions and candidate ranking.
- src/features.js: compact evidence and architecture feature extraction.
- test/tracker.test.js, test/plugin.test.js: model and Harness event-boundary tests.
- README.md, docs/PRODUCT_SPEC.md, docs/MODEL.md: installation, semantics, data and validation limits.

## Task 1: Establish the model boundary

- [ ] Write tests showing: current probability plus past candidates plus future mass sum to one; unknown trace length does not require a horizon; tool errors raise current candidate weight; candidate pruning preserves mass; separate sessions do not interfere.
- [ ] Run node --test test/tracker.test.js and confirm missing module is the failure.
- [ ] Implement createTracker(config), observeStep(sessionId, stepObservation), getSnapshot(sessionId), and forgetSession(sessionId) in src/tracker.js with finite-number validation.
- [ ] Run focused tests to green.

## Task 2: Connect actual Harness events

- [ ] Write tests for apply(ctx, config) with a fake ctx.on: one step/end produces one prediction; errors are associated with the correct sessionId, turn, step; no raw content appears in output; plugin is observe-only.
- [ ] Run node --test test/plugin.test.js and confirm missing implementation.
- [ ] Implement extraction in src/features.js and Cordis integration in index.js, using only verified session/event, agent/request-error, and agent/error payloads.
- [ ] Run focused tests to green.

## Task 3: Package and document the product

- [ ] Add package.json with dsh.bundle.patch, no install-time scripts, and cordis.patch.yml with one unique plugin row.
- [ ] Add configuration validation for base hazard, role offsets, evidence likelihood ratios, candidate cap, console output and optional JSONL path; invalid values fail load.
- [ ] Document exact dsh plugin --profile <name> add github:calledice/dsh-step-risk#<commit> install, --dump-config check, log fields, probability meaning and removal in README.md and docs/MODEL.md.
- [ ] Confirm package files and docs contain no private IP, raw data, token or sample prompt.

## Task 4: Verify and publish

- [ ] Run all Node tests and inspect final diff, manifest, patch and model output.
- [ ] If the DSH CLI is available, perform a real profile load smoke test; otherwise record that integration limit and verify against official source event types.
- [ ] Create the requested public calledice/dsh-step-risk repository through the authenticated GitHub API, then push only this product repository.
- [ ] Read back remote default branch, commit and README URL; preserve working checkout.

## Risks and mitigations

- **Uncalibrated numbers:** Label model experimental, retain explicit future probability mass and never block the agent.
- **Harness API drift:** Pin inspected revision in docs and verify event contracts in tests; avoid private APIs.
- **Cross-system labels:** Use GFA data only for research context, not as claimed DSH calibration.
- **Long sessions:** Cap individually retained candidates and move pruned mass to otherPastMass; retain only metadata.
- **Publication leakage:** Inspect tracked files and diff before push; exclude raw trajectories and credentials.

## Acceptance criteria

- AC1: GitHub-installed bundle contributes one active observer row to a DSH profile.
- AC2: Every completed DSH step emits an estimate with current, future and historical mass; arbitrary length does not require a maximum step number.
- AC3: Agent preset and delegation depth can alter the prior; hard evidence updates the current posterior; independent sessions stay isolated.
- AC4: Plugin never changes agent/tool execution and never logs raw message or tool text.
- AC5: Invalid configuration fails at load, and tests cover model and event integration.
- AC6: Public GitHub repository contains installation, model, limitations and test instructions.

## Review trail

Self-review only. The user authorized planning, development and GitHub publication in the same task; implementation proceeds inline. No independent reviewer was dispatched.
