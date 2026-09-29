# Cloud release and infrastructure workflows

Read `architecture.md` before changing shared governance. This document extends it; exact API shapes are design targets requiring installed-type and implementation checks.

The accepted IDP extension is authoritative for operation-specific runtime changes, rollback, retirement, two-role review, and Terraform controls: read `rizz-idp-lifecycle.md` and `rizz-idp-terraform.md`. The original single release recipe below remains a compatibility contract, not the complete product scope.

## Distinct workflows and gates

| Workflow | Trigger | Output | Execution authority |
| --- | --- | --- | --- |
| Application build | Authorized app source change | Tested frontend/backend images + release record | App CI ECR role |
| Foundation provisioning | Explicit platform infrastructure request | Terraform configuration PR and plan | Platform reviewer approves apply of the actual plan |
| Application release | MCP or manual Backstage proposal | Approved GitOps PR | Human merge lets Argo deploy |

Codex submitting a proposal never provisions EKS, pushes images, merges a PR, or deploys. Backstage approval creates a PR through trusted Scaffolder. Application deployment begins after human merge and Argo reconciliation. Do not run Terraform or kubectl from the Rizz.AI release template.

## Trusted release contract

Publish a release record only after both images build and required tests/scans succeed. The initial recipe uses a paired frontend/backend release from one source commit. Do not quietly support independent component releases; those need their own compatibility contract and template.

Required resolved evidence:

- Release ID, source repository and commit, successful trusted workflow/run identity.
- Full approved registry references with immutable SHA-256 digests for both images.
- Build/test/scan policy results and record/schema version.
- Integrity binding between this metadata and those images. Prefer attestations when supported; at minimum resolve from authenticated trusted CI artifacts, validate allowlisted workflow/source/registry, and record the evidence checked. A JSON file supplied by the agent is not trusted provenance.

Pin the release record or its verified digest in the proposal; do not repeatedly resolve a mutable tag. Define artifact retention and release availability: an expired/missing record or deleted digest makes the release unavailable, not implicitly trusted. Keep the previous approved release available for rollback.

## Deploy Rizz.AI template

Suggested stable ID: `deploy-rizz-ai`. Register only when backend validation, target configuration, rendering, governance, and tests support it. Merely adding a catalog template does not make it safe or runnable.

Conceptual allowed inputs:

```json
{
  "declaredIntent": "Deploy Rizz.AI release release-abc123 to EKS staging with two backend replicas; keep the backend private.",
  "templateId": "deploy-rizz-ai",
  "inputs": {
    "releaseId": "release-abc123",
    "targetId": "eks-staging",
    "frontendReplicas": 1,
    "backendReplicas": 2
  }
}
```

Select actual field names to fit the existing contract; schema-validate unknown fields. Target IDs resolve server-side to account/region/cluster, namespace, repo/branch/path, Argo Application, exposure, and authorized owner group. They are not agent-chosen connection details. Retain the existing local environment contract without conflating local `staging` and cloud `eks-staging`.

Both Deployment replica counts must be integers 1–2. Do not add a replicas field to the scheduled-worker CronJob. Optional model/runtime fields must have reviewed allowlists and enter the hash; secret values are never inputs. Initial supported workload is the full paired application, staging only, fixed public frontend and private backend. If intent requires an internal-only frontend, request clarification or use a separately approved supported recipe; do not pretend the public recipe satisfies it.

Backend checks: authenticated requester, target authorization, owner/reviewer mapping, release integrity, image existence, exact registry allowlist, bounded inputs, safe output paths, expected Kubernetes kinds/namespaces, and template version. Do not accept arbitrary YAML, images, URLs, IAM policies, scripts, or secrets.

## Semantic check and deterministic policy

Jev compares declared intent, resolved recipe purpose, current→proposed change, exposure, runtime settings, and a compact rendered summary. Do not send credentials or whole application code.

- Intent says backend private; proposal adds backend ingress: code rejects unsupported exposure; Jev may also identify scope expansion.
- Intent says frontend-only; the paired recipe updates the backend: expose the mismatch and clarify. Do not manufacture an independent-release feature.
- Intent says keep Gemini model unchanged; permitted proposed configuration changes it: Jev can flag contradiction.
- Intent is only "deploy something": insufficient intent is advisory ambiguity, not proof of alignment from default values.
- Request contains three replicas: deterministic schema/policy rejects it. Do not credit Jev with numerical enforcement or silently clamp to two.

Keep Choice, Noul, and Score visible as semantic evidence, not risk/approval guarantees. Preserve unavailable/conflicting outcomes. No automated semantic permission. An unresolved check cannot silently progress through normal approval; any later exception process needs explicit policy, authority, and audit, not a hidden fallback.

## Frozen approval and publishing

Bind approval to requester/provenance, declared intent, template/version/digest, policy version, validated parameters, target mapping, owner, source commit, verified release metadata/digest, both image digests, model/configuration, rendered file paths/content hashes, and GitOps destination.

For updates, include the reviewed base revision/current relevant file hashes. At publishing detect changes to the same app/configuration since preview; require a refreshed diff/review rather than silently overwriting concurrent work. Unrelated repo changes can be handled only if the exact approved output and relevant preconditions still hold.

A distinct authenticated authorized reviewer approves the exact snapshot under its recorded policy version. The IDP routine-change reviewer may be an authorized rizz-team or platform-team member; retirement remains platform-only. Existing snapshots retain their original review requirements. Trusted Scaffolder consumes the frozen files with a task-bound execution claim, revalidates approval/target/release, and opens at most one PR per proposal. Retry idempotently; do not invent success after an API timeout. Any execution-affecting mutation invalidates approval.

GitOps PR checks should validate manifests, allowed paths/resources, digest-only images, private backend, limits, and links to approval evidence. Enforce authorized merge and required checks with the repository controls available. Recognize that people allowed to edit protected GitOps paths directly remain part of the trust boundary; do not claim portal approval governs every cluster change without enforceable repository/admission controls.

## Delivery observation

Keep proposal/task state separate from observed release state. Show PR opened/merged, observed Argo revision/sync/health, both Deployment rollouts, and smoke verification with timestamps and failure details. Refresh is read-only and never triggers deployment or sync.

Verify the intended files/digests at the actual Argo-synced revision, not merely that the old merge commit is an ancestor. Require correct cluster/namespace, observed generation, desired/updated/available replicas, ready Pods, expected images, and smoke results before declaring delivery verified. Multi-architecture runtime image IDs may reference platform manifests; verify the registry relationship rather than doing a naive digest-string equality.

Later shared-repo commits must not falsely verify a changed app. Distinguish `superseded` by a newer approved release from failed/unavailable/not verified. Missing GitHub/Argo/Kubernetes data must not retain a misleading fresh green status. Display the last observation as stale if retained.

## Rollback

Select a retained previously verified release and submit a fresh governed proposal restoring its image pair and compatible configuration. Open and merge a reviewed GitOps PR; let Argo reconcile. Verify both workloads and smoke tests. A direct imperative rollback can be overwritten by auto-sync and is not the normal release path. Infrastructure rollback is a separate reviewed plan, not a Git revert blindly applied to AWS.

## Terraform request template

Required IDP capability: platform-only infrastructure requests restricted to platform-defined module inputs. The complete portal, runner, plan/apply/destroy contract is in `rizz-idp-terraform.md`. A request creates a configuration PR, never executes arbitrary Terraform or browser-supplied shell.

Workflow: request → platform review of configuration → PR → CI validation/plan → authorized review of actual plan → apply exact approved saved plan → record outcome/drift. If branch, configuration, variables, module/provider locks, backend/state assumptions, or plan artifact change, rerun plan and renew approval. Serialize state changes; never apply an old plan automatically after state conflict.

Record plan hash, source commit, target account/region/state, creates/updates/deletes, workflow identity, and reviewer. Protect plan/state artifacts from public logs. CI policy rejects unauthorized resource types/regions, unexpected destructive changes, and target mismatches. Merge alone must not mean blind apply if the actual plan has not been reviewed.

State/OIDC/initial EKS/Argo bootstrap can be operator-run through a documented reviewed procedure; the portal need not already be hosted in EKS. The required infrastructure UI must expose actual saved-plan review and runner outcomes after bootstrap. Destruction uses a dedicated platform-only workflow with exact scope, explicit authorization, reviewed destroy plan, and teardown checks; routine release approvals never authorize it.
