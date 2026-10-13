# DSH Turn Failure Forecast Implementation Plan

> **For agentic workers:** Implement each task with a focused red/green test cycle, inspect the final diff, and run the rc.2 host smoke test before delivery.

**Goal:** Add an honest, prefix-only forecast of whether the current DSH turn objective will fail, while preserving the existing experimental estimate of a completed step's contribution.

**Architecture:** Keep `stepFailure` as the existing uncalibrated condition-chain estimate. A separate `turnRisk` model reads only bounded, structured step records already retained by the plugin. An offline trainer matches manually adjudicated success and failure labels to whole turns, fits smoothed empirical risk buckets, and evaluates them on later, session-separated turns. The host loads only a model that passed the declared gate; without one it returns `null` and an explicit unavailable status. The existing store schema remains readable, and risk is projected onto stored steps at read time.

**Tech Stack:** Node.js 22/24 ESM, built-in `node:test`, DeepSeek Harness 0.2.0-rc.2 Cordis events and Connection route, React classic-script client.

## Global Constraints

- Prediction target: `Y_turn = failure` for a manually adjudicated, completed user objective in one DSH `turn`. `turn/end` and tool `isError` are observations, never ground-truth labels.
- `pre` uses completed steps with position strictly before the current `step/start`; `post` includes only the just-completed step. `post - pre` is an association, not a causal effect.
- Step contribution `J_i` and turn risk `q_t` have different denominators and must never be fused or normalized together.
- No prompt, arguments, output, raw error text, labels, session IDs, or fitted examples enter the model artifact. Session IDs remain only in the existing local records.
- No external model call, environment replay, fixed-threshold abort, webhook, or new unauthenticated endpoint.
- `dsh-step-risk` is the only Git repository to commit and push. The parent knowledge-base tree contains unrelated changes.

## File Map

- `src/turn-risk.js`: prefix summary, empirical bucket training, temporal holdout evaluation, model validation/loading, prediction, and step projection.
- `scripts/train-turn-risk.mjs`: private label/record CLI and safe model/report output.
- `index.js`: load model, publish the `step/start` forecast, expose an active forecast, and decorate completed steps at the snapshot read boundary.
- `client.js`: distinguish the step contribution estimate from current-turn outcome risk; display unavailable or evaluated model state and pre/post values.
- `test/turn-risk.test.js`, `test/train-turn-risk.test.js`, `test/plugin.test.js`, `test/client.test.js`: behavior and privacy regression checks.
- `docs/FAILURE_PROBABILITY_DESIGN.md`, `docs/MODEL.md`, `docs/PRODUCT_SPEC.md`, `README.md`, `docs/VALIDATION.md`: definitions, label protocol, runbook, and measured evidence.

### Task 1: Prefix model and offline training

**Interfaces:** `summarizeTurnPrefix(rows)`, `trainTurnRiskModel(labeledTurns)`, `predictTurnRisk(model, rows)`, `projectTurnRisk(steps, modelState)`, `loadTurnRiskModel(path)` from `src/turn-risk.js`. A labeled turn is `{ sessionId, turn, outcome: 'success'|'failure', completedAt, steps }`. The saved model contains only feature/model versions, smoothed bucket counts, a global baseline, gate result, and aggregate holdout metrics.

- [ ] Write tests showing that a turn with no previous step has the same pre state regardless of the current tool result, that a read failure and action failure have different **observed state** buckets, and that a later revision changes the post forecast of that position without using future steps.
- [ ] Run `node --test test/turn-risk.test.js`; expected red result: the new module or exports are absent.
- [ ] Implement bounded prefix categories: completed-step bucket, maximum observed error severity, and whether a request error has occurred. Build smoothed empirical frequencies from labels only; back off from a sparse exact cell to a broader cell and then a global rate. The prediction result is `{ status, value, modelVersion, horizon, support }` with `value: null` when unavailable.
- [ ] Train on earlier whole-session groups and evaluate on later whole-session groups. Require at least 100 labeled turns, 30 held-out turns, and both classes in each partition; declare a model eligible only when held-out Brier and log loss do not exceed a training-prevalence baseline and five-bin ECE is at most 0.10. Include the bin edge at 1.0. Record actual sample sizes and scores; no hard-coded accuracy claim.
- [ ] Write CLI tests for missing/conflicting labels, an incomplete label, no success class, unsafe output data, and a deterministic synthetic set that passes the gate. Run `node --test test/turn-risk.test.js test/train-turn-risk.test.js`; expected green.

### Task 2: Host and client integration

**Interfaces:** `index.js` keeps the existing `step-risk/prediction` event and GET `/api/dsh-step-risk/snapshot`; it adds an optional `step-risk/turn-forecast` event at `step/start`. The GET response keeps `schemaVersion: 1`, adds `turnRiskModel` and `activeTurnForecast`, and adds `turnRisk` to each returned step without changing the durable row schema.

- [ ] Extend `test/plugin.test.js` first: with no model, the pre event and GET projection use `value: null`; with a valid model, `step/start` sees only earlier rows, `step/end` exposes pre/post, session/turn boundaries do not bleed, and a late `agent/error` revises the current post value.
- [ ] Run `node --test test/plugin.test.js`; expected red result: the new event/projection is missing.
- [ ] Load the optional model from a bounded profile-local file at plugin start; invalid/missing files abstain without crashing the host. Keep active forecasts bounded by the configured session limit and clear them at step completion/disposal. Decorate read output and emitted predictions from allowlisted stored facts.
- [ ] Extend `test/client.test.js` first for the unavailable and evaluated forecast states, visible phase/target labels, and no causal wording. Run it to observe the missing UI, then update `client.js` and rerun it green.
- [ ] Run `node --test`; expected no failures, skips, or cancelled tests.

### Task 3: Scheme and documentation

- [ ] Add `docs/FAILURE_PROBABILITY_DESIGN.md` with the precise target, observability table, feature timing, label adjudication, grouped chronological evaluation, model eligibility, privacy, and acceptance limits.
- [ ] Update `docs/MODEL.md`, `docs/PRODUCT_SPEC.md`, and `README.md` to describe both values separately, show the private JSONL label format and CLI commands, and state that no model means no turn-failure probability. Keep the 0.2.0-rc.2 installation instructions correct.
- [ ] Keep the local `Failure_Probability` review and Word revision in its own folder; do not add its raw research corpus or private labels to the plugin package.
- [ ] Check links, example JSON, source-to-model field names, and `npm pack --dry-run` contents.

### Task 4: Verify and publish

- [ ] Run the complete unit suite and actual `node scripts/verify-dsh-runtime.cjs --report ...` rc.2 smoke test on the final code. Run `node scripts/verify-client-browser.cjs` if its browser dependencies are available; inspect the produced report and image.
- [ ] Check the existing desktop `link:` installation against the new source, the active desktop profile, host version, and a new step record. Report the actual UI evidence separately from isolated smoke evidence.
- [ ] Obtain an independent read-only review of the final plugin diff and resolve P1/P2 findings; inspect the exact staged files, then commit and push to `calledice/dsh-step-risk` without force.

## Self-Review

- The plan covers the implementable DSH portion of the source proposal: prefix risk, step contribution, records, UI, labels, evaluation, and rc.2 delivery. Framework-neutral SDKs, logprob fusion, Monte Carlo replay, and intervention lack the current host/data contract and are documented as future research.
- All new probabilities have an explicit target and validation state. Missing labels leave the new target unavailable rather than substituting tool errors or the old step estimate.
- No step depends on a file or symbol outside the file map, and the existing schema is deliberately retained.
