# Delivery plan and proof

## Suggested workspace shape

The requested directory is the future Backstage application repository. The GitOps repository is a future sibling, not nested inside this skill.

```text
/home/yash/backstage-agent-guard/
  .agents/skills/backstage-agent-guard/  # This skill
  packages/app/                          # Backstage frontend, when implemented
  packages/backend/                      # Backstage backend
  plugins/agent-guard/                   # Approval UI
  plugins/agent-guard-backend/           # Proposal, policy, Jev, MCP actions
  catalog/templates/                     # Three platform-owned Template entities
  catalog/entities/                      # Seed users, groups, components

/home/yash/backstage-agent-guard-gitops/  # Create when implementation is requested
  argocd/                                # Argo CD Application
  apps/staging/                          # Kustomize overlay, service manifests
```

Do not create code, Git repositories, GitHub repos, cloud resources, or the sibling GitOps directory merely because this skill describes them. Implement when requested.

## Stack

- Backstage current stable compatible release, TypeScript, React, Node.js backend.
- Official `@backstage/plugin-mcp-actions-backend` and Actions Registry for proposal/status actions.
- Backstage Scaffolder and three Template entities for trusted execution.
- TypeSafe Jev API for Noul, Choice, Score semantic checks; separate server-side credential.
- SQLite for proposal and audit state in the local demonstration.
- GitHub PR, Kustomize, Argo CD, Kind.
- Backstage community Argo CD plugin if compatible; otherwise read-only Argo CD link/status adapter.

Pin package versions and demo image digests at implementation time. Verify current API signatures against installed package types and `sources.md`.

## Milestones and acceptance checks

### 1. Backstage foundation

- Scaffold a new Backstage app without overwriting this skill.
- Seed Group/User entities and one example Component. Add Agent Guard navigation.
- Register the three Template entities with narrow schemas and fixed images.
- Verify each appears at `/create` and produces or dry-runs its intended files where supported.

### 2. Proposal backend and MCP

- Add a proposal store and explicit state transitions. Register `submit-proposal` and `get-proposal-status` through Actions Registry.
- Install official MCP Actions and restrict action sources. Inspect the actual default tool list; this is a required bypass check.
- Choose and test identity flow: per-user MCP OAuth/CIMD with the New Frontend System, or a scoped service token plus mandatory authenticated Backstage claim/confirmation. Never derive a developer requester from a shared token.
- Validate names, template IDs, environment, ownership references, and target paths before state writes. Derive intent provenance server-side and requester from a user principal or later authenticated confirmation.

### 3. Jev and policy

- Add a typed Jev adapter with distinct unavailable/error result.
- Use fixtures: aligned request; wrong language/template; worker proposed as API; unrequested ingress; missing environment; staging/production conflict.
- Compare primary Choice against human-labeled examples. Display Noul and Score as diagnostics. Include a simple deterministic baseline for the blog.
- Implement pure deterministic policy and store both policy reason codes and Jev evidence. Model failure cannot authorize execution.

### 4. Approval and Scaffolder

- Render/freeze GitOps output and compute approval digest. Build pending/detail/history UI.
- Enforce reviewer permissions in the backend. Record approval/rejection and audit events.
- Require a reviewer distinct from the requester for all proposals, including same-team requests. Guest proposals are demo-only and cannot be approved.
- Enforce Scaffolder permissions for protected templates and dry runs; verify `/create` and direct task REST cannot bypass review. Gate the GitOps publisher on an approved snapshot and task-bound execution claim even if a task is started unexpectedly; retries must remain idempotent.
- Start the matching Scaffolder task from a trusted path; verify it consumes the frozen snapshot or equivalent output.
- Create GitOps PR and persist URL/task ID. A retry must not create another PR for one proposal.

### 5. GitOps demonstration

- Create sibling GitOps repo and Kind cluster when implementation is authorized.
- Install Argo CD, configure one staging Application with automated sync of the tracked branch, and map catalog entity to its Application.
- Demonstrate PR open → merge → Argo CD syncing → Synced and Healthy. Confirm actual Kubernetes resources, not only a displayed status.

## Tests that matter

1. No Scaffolder task or GitOps write occurs before approval.
2. MCP-visible tools exclude direct `scaffolder.execute-template` and private publisher.
3. Direct Scaffolder UI, task REST, and dry-run paths cannot publish protected GitOps output without a live approved snapshot.
4. Changing declared intent/provenance, template ID/version, input, owner, environment, GitOps path, or generated files invalidates approval.
5. Agent-supplied intent provenance, requester, or reviewer values cannot override backend records and authenticated identity.
6. A shared MCP service token cannot impersonate a developer; the fallback claim/confirmation is mandatory.
7. Jev `aligned` cannot override policy denial; Jev unavailable or ambiguous does not auto-allow.
8. Reviewer permission is checked server-side, not only via hidden buttons.
   A requester, including one in the owner group, cannot approve their own proposal.
9. Duplicate execution/PR retries do not create a second change.
10. PR open, merged, Argo CD Synced, and workload Healthy are separate observable states.
11. Only the three platform-owned templates can be selected; arbitrary YAML or repository is rejected.

Use unit tests for policy, normalization, digest, state transitions, and Jev parsing; integration tests for MCP visibility and approval-to-Scaffolder handoff; one local end-to-end GitOps demo. Do not claim a mocked test exercised GitHub, Argo CD, or Kind.

## Portfolio and blog artifacts

Prepare one architecture diagram, approval-page screenshots, one successful demo recording, and one semantic mismatch demo. The blog should explain the developer problem, Backstage's catalog/MCP/Scaffolder roles, Jev's bounded semantic judgment, deterministic policy, frozen approval, separate PR merge, Argo CD deployment, test evidence, and prototype limits. Resume claims should describe observed implementation only.

Once verified, a concise resume line is: “Built a Backstage plugin governing Codex service-creation proposals through official MCP Actions, Jev intent checks, hash-bound approval, Scaffolder-driven GitOps PRs, and Argo CD deployment to Kind.”
