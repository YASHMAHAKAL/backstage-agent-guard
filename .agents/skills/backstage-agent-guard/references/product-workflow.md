# Product and user workflow

## Purpose and actors

This is a portfolio demonstration for platform engineering, DevOps, SRE, and cloud roles. It should make the governance boundary visible without attempting a production platform.

| Actor | Job |
| --- | --- |
| Platform owner | Creates and versions three trusted Backstage Scaffolder templates. |
| Developer | Requests a service through Codex and inspects its proposal. |
| Codex | Chooses a template, supplies permitted parameters, submits a proposal, polls status. |
| Agent Guard backend | Validates inputs and identity, reads catalog context, calls Jev, applies policy, stores state, starts approved tasks. |
| Reviewer | Distinct authenticated member of the requested owner group who approves or rejects the frozen proposal. |
| Scaffolder | Executes a pre-existing template after approval and opens a GitOps PR. |
| PR merger | Merges the GitOps PR as a separate release decision. |
| Argo CD | Reconciles the merged Git state to Kind. |

## Three platform-owned templates

| Template ID | Purpose | Kubernetes output |
| --- | --- | --- |
| `nodejs-api` | Internal, always-running Node.js HTTP API | Deployment + ClusterIP Service |
| `fastapi-api` | Internal, always-running Python FastAPI HTTP API | Deployment + ClusterIP Service |
| `scheduled-worker` | Scheduled background work | CronJob |

Use pinned prebuilt demo images. The initial templates do not provision public ingress, databases, arbitrary images, source repositories, cluster credentials, or executable shell steps supplied by the agent. Template inputs should be narrow: `serviceName`, `requestedOwner`, `environment` (staging in runnable demo), description, and schedule where relevant. API templates accept a reviewable integer `replicas` value from 1 through 2; the scheduled worker is a CronJob and has no Deployment replicas field. Backend configuration owns cluster, namespace, image, repository, resource defaults, and paths. Validate the requested owner against catalog context and policy.

## Successful journey

1. Developer asks Codex: “Create a staging Node.js payments API called `payments-api` owned by `payments-team`.”
2. Codex calls `agent-guard.submit-proposal` with `declaredIntent`, `templateId: nodejs-api`, and allowed inputs. It receives a proposal ID and status link. The backend records `intentSource: agent_supplied`; Codex does not choose provenance.
3. Backend authenticates the caller, validates schema and supported template, resolves catalog context, and renders a deterministic preview of the GitOps files. Reject unsupported environments and unsafe paths before Jev. If MCP authentication is only a static service token, an authenticated developer must claim and confirm the proposal in Backstage before review; do not infer developer identity from the token.
4. Jev compares declared intent with the proposed template, inputs, and compact rendered summary. Store results as advisory signals. An unavailable or conflicting Jev result cannot become permission.
5. Deterministic policy selects the review lane. Backstage shows requester, intent provenance, template/version, parameters, GitOps target, manifest diff, policy reasons, Jev outputs, and proposal digest.
6. A different authenticated member of the requested owner group approves in Backstage. The requester cannot approve their own proposal. Backend rechecks state, reviewer authority, and proposal digest, then starts a trusted Scaffolder task.
7. Scaffolder consumes the approved snapshot and opens a GitOps PR. Store task ID and PR URL; show failures accurately.
8. A human merges the PR. Argo CD observes the tracked branch and syncs the Kind staging namespace. Backstage links the catalog entity and displays sync and health status.

## Mismatch examples

- Declared intent: “Create an internal scheduled payments worker.” Proposal: `nodejs-api`, an always-running Deployment. Jev should flag wrong workload type or scope expansion.
- Declared intent: “Create an internal service.” Proposal: public ingress. The initial hard template policy rejects public ingress; Jev can still show a semantic mismatch in an evaluation fixture.
- Declared intent says staging but `inputs.environment` says production. The current contract has no second trusted structured environment field, so this is a semantic mismatch for Jev and human confirmation, while the MVP policy also rejects production outright. If a separate structured request field is later added, code can compare the fields exactly; that comparison still does not prove the agent quoted the user's intent faithfully.

## Proposal contract

Initial MCP request shape; adjust precise schema during implementation:

```json
{
  "declaredIntent": "Create a staging Node.js payments API",
  "templateId": "nodejs-api",
  "inputs": {
    "serviceName": "payments-api",
    "requestedOwner": "group:default/payments-team",
    "environment": "staging",
    "description": "Internal payments API",
    "replicas": 1
  }
}
```

Do not accept `intentSource`, a requester, reviewer, cluster URL, arbitrary repository, image, complete template YAML, Kubernetes manifest, or executable script as authority from the agent. The backend records `intentSource: agent_supplied` for MCP submission. Derive requester from a user principal, or leave it unclaimed until an authenticated Backstage developer confirms it when using service-token MCP. Store Jev model/version, questions, outputs, confidence when provided, usage/latency when available, and failure separately from final policy outcome.

MCP tools to consider:

- `agent-guard.submit-proposal`: creates a proposal; never runs Scaffolder.
- `agent-guard.get-proposal-status`: returns state, next step, and safe links.
- `agent-guard.list-my-proposals`: optional read-only convenience.
- `agent-guard.cancel-proposal`: optional state change before execution.

Use stable proposal IDs for polling. Approval occurs through authenticated Backstage backend APIs, never an agent-callable approval tool.

## State meanings

Suggested states: `submitted`, `needs_clarification`, `pending_approval`, `rejected`, `approved`, `scaffolding`, `pr_open`, `merged`, `syncing`, `deployed`, `failed`, `cancelled`. Enforce allowed transitions. An open PR is not deployed; Argo CD Synced is not necessarily Healthy. Polling GitHub and Argo CD is acceptable for the MVP.

## Approval page

Show declared intent and its source, template ID/version, validated parameters, owner relation, requester, environment, namespace, GitOps repository/path, readable manifest diff, policy reason codes, Jev Noul/Choice/Score details, digest, approver and timestamp, Scaffolder task, PR, Argo CD state, and audit history. Let a human confirm or correct intent; a correction invalidates old Jev results and approval digest and requires re-evaluation before review continues. Hide buttons for unauthorized reviewers and enforce the same rule on the backend. Do not invent a prose “Jev reason” when the API only returned typed scores.

## Two repositories

1. `backstage-agent-guard`: Backstage app, Agent Guard plugins, three Template entities, skeletons, seed catalog entities, tests, and this skill.
2. `backstage-agent-guard-gitops`: Kustomize manifests, Argo CD Application, and any catalog descriptor needed for this demo.

Scaffolder writes to the GitOps repository by PR. It does not create a third application source repo. If full source scaffolding is requested later, explicitly plan the extra repo and image build flow.
