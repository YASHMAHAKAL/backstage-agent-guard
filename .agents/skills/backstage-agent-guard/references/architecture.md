# Architecture and decision rules

## Data flow

```text
Developer → Codex CLI/IDE → Backstage MCP Actions → Agent Guard backend
                                            ↘ Catalog + authenticated identity
                                             → Jev semantic check
                                             → deterministic policy
                                             → proposal store + Backstage approval UI
Reviewer → approved snapshot → private Scaffolder execution
                                  → GitOps PR → human merge
                                  → Argo CD → Kind staging namespace
```

Backstage can run locally outside Kind. Argo CD and sample workloads run in Kind. The backend needs Backstage/Scaffolder and GitHub access; this workflow does not require it to mutate Kubernetes directly.

## Backstage MCP boundary

Use `@backstage/plugin-mcp-actions-backend` with custom Agent Guard actions registered in the Actions Registry. Configure `backend.actions.pluginSources` to admit Agent Guard and only deliberately safe additional action sources. The default `/api/mcp-actions/v1` endpoint exposes every action registered from admitted sources even when named filtered servers exist. Do not rely on a named server filter to hide `scaffolder.execute-template`; keep the `scaffolder` action source out of agent-visible registration. Scaffolder may remain installed for its normal backend task execution.

Confirm exact APIs against the installed Backstage release; Actions Registry has alpha surfaces. Declare accurate action metadata and `visibilityPermission` where useful, but metadata is not the approval system. The proposal action writes database state and is not read-only. Derive requester from authenticated principal, not an MCP argument. A local static token may simplify development, but do not claim it proves a particular end user; use proper user identity or clearly label the demo simplification.

For an end-to-end per-developer demo, prefer MCP OAuth with Client ID Metadata Documents (CIMD). Current Backstage documentation requires the New Frontend System, `@backstage/plugin-auth-backend`, and `@backstage/plugin-auth`; verify Codex connects as a user principal. If that setup is too much for the local MVP, use a tightly scoped static service token only for proposal submission, then require the developer to authenticate in Backstage and explicitly claim/confirm the proposal before it can enter review. Never attribute a static-token submission to a named developer or use agent-supplied identity as a substitute.

MCP action filtering does not close Scaffolder's own UI/API. Backstage exposes task creation separately, including `POST /v2/tasks`, and has `taskCreatePermission`, `templateDryRunPermission`, and `actionExecutePermission`. Configure backend permissions so ordinary users/agent credentials cannot execute the protected templates directly. The trusted execution service must still be able to start the approved task. As defense in depth, the custom GitOps publishing action checks the server-side approved proposal ID, exact snapshot digest, and an execution claim bound to that task immediately before publishing; raw template inputs or an arbitrary ID cannot satisfy that check. An approved proposal can produce at most one GitOps PR; safe retries reuse the same execution record and PR. Validate the precise service-principal permission flow against the installed Backstage release. Restrict who can ingest or edit Template entities, so an untrusted template cannot sidestep the publisher.

## Trust and authority

| Signal | Meaning | Permitted use |
| --- | --- | --- |
| Agent `declaredIntent` | Agent-supplied claim | Semantic comparison and human review; not verified user words |
| Backend-recorded `intentSource` | Submission-channel provenance | Distinguish unconfirmed agent claim from authenticated human confirmation |
| Agent template and inputs | Untrusted proposal | Strict schema and allowlist validation |
| Authenticated principal | Identity evidence | Requester attribution, permission checks |
| Catalog ownership relation | Organizational context | Find likely reviewer; not sufficient authorization by itself |
| Template version | Platform-owned artifact | Render and bind exact approved proposal |
| Jev outputs | Advisory classification | Flag mismatch, expansion, ambiguity |
| Permission/policy result | Enforced authorization | Submit, review, and execute gates |
| Approval record | Human decision on frozen snapshot | One execution subject to revalidation |
| Argo CD status | Observed cluster state | Display sync and health |

Backstage's catalog documentation warns that ownership metadata alone is not an authorization mechanism. Prefer catalog relations for context, then check actual reviewer rights through Backstage permissions or explicit local demo policy.

## Deterministic policy

Implement a pure function over validated facts, authenticated identity, catalog context, and known policy configuration. Example MVP order:

1. Deny malformed input, unsupported template/environment, unauthorized caller, unsafe target, or arbitrary code/configuration.
2. Hold or deny when required identity/catalog context is missing. Jev cannot fill an authorization gap.
3. Deny unsupported capabilities such as public ingress, irrespective of Jev.
4. For allowed staging requests, require a distinct member of the requested owner group to review; the requester cannot approve their own proposal, even when they belong to that group.
5. If semantic analysis finds a material mismatch, scope expansion, ambiguity, or fails, prevent automatic progression and request correction or human examination. Jev cannot lower a review requirement.

Read-only status access remains scoped to authorized proposal viewers. The shared guest identity is only for proposal/UI exploration: it cannot review, and its proposals cannot later be approved after real auth is enabled. Production deployment is outside the runnable local MVP; show unsupported/review-only behavior rather than suggesting a production cluster exists. If production is added later, require platform review. Destructive templates are outside the initial scope.

## Jev's job

Send compact state: declared intent, selected template purpose, validated inputs, and short rendered output summary. Keep math, identity, membership, exact field comparisons, and hard permissions in code. Use one TypeSafe evaluation with three typed questions when possible:

- **Choice, primary:** `aligned`, `wrong_template`, `scope_expansion`, `contradiction`, `insufficient_context`. Give clear criteria. This is the advisory mismatch category.
- **Noul, diagnostic:** “Does the proposal preserve the declared intent without adding material capabilities?” Show its yes probability, not an authorization threshold.
- **Score, diagnostic:** ordered mismatch rubric: `0=no material mismatch`, `1=minor ambiguity`, `2=material omission`, `3=major unrequested scope`, `4=direct conflict`. Display rubric/probabilities; do not label the weighted expectation a precise operational risk number.

These are independent views, not votes. TypeSafe does not guarantee structural agreement across question types. If they conflict, show the conflict and do not automatically approve. Choice confidence differs from selected-option probability. Missing answers, invalid options, provider failures, low confidence, or adversarial text produce `unknown`/`needs_clarification`, never permission. Keep secrets and large irrelevant manifests out of Jev state. Do not fabricate natural-language explanations from typed output; UI can show exact local evidence and policy reason codes.

## Approval integrity

Before review, normalize inputs, resolve the platform template/version, and render or freeze exact GitOps output. Store an immutable execution envelope with proposal ID, declared intent and backend-recorded provenance, authenticated requester, template ID and digest, validated inputs, environment, GitOps repository/path, generated file hashes, and policy version. Show execution-affecting fields in the UI.

Canonicalize the envelope consistently (RFC 8785 is available) and SHA-256 hash it. Store approval with reviewer, timestamp, digest, and state. At execution, recompute from the stored snapshot, check permissions, and reject if digest changed, approval was consumed/expired, or state is invalid. Any edit creates a new proposal version. Scaffolder consumes the frozen files or rerenders from the pinned template and checks output hashes before publishing. Do not advertise exact manifest approval if only abstract parameters were reviewed and output could change later.

Make branch/PR creation idempotent by proposal ID to avoid duplicates after retries. Persist external IDs and failures. Keep approval state server-side; the digest alone is not an authorization token.

## Scaffolder and GitOps

Platform owners register the three Template entities before agent requests. Agent Guard starts the selected template through a private backend path only after approval. A narrow custom Scaffolder action should consume the approved snapshot and gate GitOps publishing, optionally calling Backstage's GitHub pull-request publishing action after its own checks. Do not expose this publisher through MCP. Templates must not take arbitrary repo URLs, image names, scripts, or cluster targets from the agent.

The PR targets staging manifests in the GitOps repository. Human merge is the second gate. Argo CD watches the merged branch; Backstage displays PR open, merged, Syncing, Synced, and Healthy as distinct states. Use the community Argo CD plugin if compatible with the chosen Backstage release, or a small read-only status adapter. Ensure catalog links resolve at the appropriate stage.

## Local-demo limits

Codex CLI can use the user's ChatGPT Plus plan; Jev needs a separate TypeSafe API credential. Keep TypeSafe and GitHub credentials server-side and out of tool schemas, Jev state, logs, approval screenshots, and committed examples. Seed users/groups and SQLite are acceptable locally. State in the blog which controls are illustrative. Do not claim production identity isolation, distributed locking, or cryptographic proof of original user intent. Local tests should prove no direct Scaffolder MCP route, no Scaffolder UI/REST or dry-run publishing bypass, no execution before approval, and no execution after a proposal mutation.
