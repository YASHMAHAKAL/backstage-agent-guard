# Rizz.AI Backstage Terraform controls

## Required outcome and authority

Terraform controls are required IDP scope for platform-team users. Build a working infrastructure area for bounded foundation setup, supported infrastructure capacity changes, plan review, approved apply, drift/status, and separately reviewed foundation teardown. Application users see environment readiness, not sensitive plans or controls. The backend authorizes all reads/mutations; platform membership alone cannot launch an unapproved apply.

Backstage coordinates requests, previews, review and execution history. A designated runner executes pinned Terraform with separate AWS authority and remote state. Scaffolder can prepare a configuration PR; it must not run browser-supplied shell or apply infrastructure using the release-publisher credential. Agent tools submit/status only; they cannot approve plans, apply, destroy or dispatch arbitrary workflows.

The existing local Terraform roots under `infra/aws/bootstrap`, `infra/aws/registry` and `infra/aws/environments/staging` are starting code, not proof of created resources or working CI. Inspect actual resources/state before plans. Keep app source changes out of infrastructure triggers. Preserve Terraform/Argo/controller ownership boundaries.

## Bounded requests

| Operation | Inputs and restrictions | Result |
| --- | --- | --- |
| Foundation setup | Fixed reviewed account/profile, us-east-1, state roots, target identity, compatible EKS/add-on/module versions and staging network recipe | Configuration PR, evaluated actual plan, approved runner apply, verified outputs/bootstrap state |
| Capacity change | Allowed managed-node profile/count within reviewed budget/capacity bounds; actual resource changes visible | Infrastructure PR and plan; independent of application replica change |
| Drift inspection | Fixed root/target and read-authorized runner; no auto-remediation | Timestamped plan/read result and drift summary |
| Foundation teardown | Exact roots/resources plus retention decisions; confirmed app/ALB cleanup prerequisite | Reviewed saved destroy plans, runner results, residual resource verification |

Pick real allowed node profiles/counts from measured workload/controller requests, compatibility and pricing before exposing choices. No arbitrary region/account/module URL/provider version/IAM policy/CIDR/script or Terraform file input. Network/IAM/module maintenance uses reviewed platform repository changes, not unrestricted self-service. Resource schemas and bounds are policy versions and enter the approval record.

## Concrete workflow and approval artifacts

1. Authenticated platform requester submits a typed request and declared intent. Backend resolves the allowed root/module/target, compares existing config, and validates the operation/budget scope. Jev may flag semantic expansion using sanitized config/plan summaries; it never interprets raw state or grants AWS authority.
2. Freeze configuration changes and open a reviewed platform configuration PR via the trusted executor. Track it separately from the application GitOps PR. PR approval does not authorize Terraform apply.
3. CI performs formatting/validation/module tests and planning through a runner with least-privilege, supported target access. Untrusted PR code/forks cannot obtain privileged AWS sessions. Speculative PR plans are labeled speculative and cannot be applied.
4. After the reviewed configuration revision is finalized, generate the executable saved plan for that exact commit/root/variables/backend/state/provider locks. Hash the plan artifact; keep it private and short-lived. Plan at PR head before merge is acceptable only if execution verifies the merged configuration is identical and all recorded preconditions remain valid; otherwise regenerate the executable plan after merge.
5. Backstage displays sanitized create/update/delete/replace counts, resource addresses/types, meaningful before/after changes, root/account/region, source commit, plan digest, cost assumptions and state preconditions. Sensitive attributes are redacted; raw state/sensitive plan JSON must not be returned to browser, Jev or MCP. Privately retain full plan for authorized execution.
6. A distinct platform reviewer explicitly approves the executable plan artifact. Bind approval to request, requester, reviewer, operation, commit/config/variable hashes, backend/state lineage+serial, root, expected account/region, module/provider/Terraform versions, workflow/run identity, plan hash and expiry. The corresponding exact artifact is what the runner consumes.
7. Runner validates the server approval and authenticates its own target, retrieves/verifies the plan, serializes state operations, and applies the saved plan. It never replans-and-applies under an old approval or uses bare `apply -auto-approve` in place of the reviewed artifact. Record run ID, status, sanitized output references and approval consumed state; timeouts are not success.
8. Backstage independently reads run outcome and approved outputs/target readiness. Show queued/planning/awaiting-review/applying/applied/failed/unknown separately. Applied infrastructure is not proof of app deployment or controller bootstrap completion. Expose actionable error/runbook links and require a fresh plan after partial apply/state movement.

Implement the runner/provider adapter before activating Apply/Destroy controls. GitHub Actions with OIDC is the preferred existing-repo fit; inspect private-repository approval/protection features actually available. If native reviewer gates are unavailable, enforce the backend-issued approval/artifact/run binding with a protected credentialed runner; do not claim a freely dispatchable workflow has two-person security. If no enforceable automated gate can be implemented under the account capabilities, document the concrete limitation and scoped operator execution honestly; this does not satisfy the full automated control acceptance criterion.

## Credentials, state and bootstrap

Use short-lived OIDC credentials for CI with trust conditions matched to the actual repo/workflow/branch or protected environment subject. Verify current subject formats, not only a copied example. Infrastructure plan/apply roles are separate from ECR publishing, release reading, Backstage GitHub publishing, and cluster observation. Scoped plan access still exposes metadata; restrict it to trusted platform runs. Apply role has necessary resource authority, constrained by approved root/account/region and runner enforcement.

Remote state uses encrypted/versioned/private S3 and supported native locking. Serialize operations per state key and handle lock conflicts without bypassing locks. Treat plan/state/config with sensitive values as private artifacts; never commit them. Secret values should be loaded through approved out-of-band secret handling, not Terraform vars/state when avoidable. Preserve bootstrap state/bucket protection and reviewed retention.

Document dependency ordering: secure local bootstrap → state/OIDC/registry roles → ECR image publishing and EKS foundation → controller/Argo/secret-sync installation → observed target configuration → application requests. The portal can run locally throughout. Initial state/OIDC bootstrap requires an existing operator identity; show this as setup, not a circular workflow that requires its own uncreated runner/cluster. Record exact bootstrap actions and their plan evidence. Resume automation once its dependencies exist.

Reject stale/expired/swapped plans, changed source/vars/locks/target, cross-account identity, state conflicts, missing approval, self-review and replay. If any execution precondition changes, plan again and renew approval. Do not apply an old plan merely because it was approved earlier. An ambiguous runner launch must be resolved by request/run identity before another dispatch.

## Cost and teardown controls

Carry forward the user's maximum US$5 AWS spend, four-hour checkpoint from first resource creation, and intent to start teardown shortly after successful verification. These constrain plans and the demo, not a guaranteed hard cap or permission to create/delete resources. Refresh current regional estimates for EKS, workers, NAT, ALB, public IPs, EBS, ECR, secrets/logs and variable traffic. Budgets are alerts, not automatic spending enforcement. Keep the deadline visible and use a teardown runbook prepared before first creation.

App retirement removes controller-owned ALB resources while controllers/cluster access still exist. Foundation destroy starts only after checking ingress/ALB cleanup and app ownership, with an explicit saved destroy plan and platform approval. Destroy staging before removing supporting roles/controllers that it needs. Registry/state roots may be retained or separately destroyed under their own scoped plan; retain rollback images until app retirement/recovery is finished. Never destroy the state bucket while dependent roots need it, and never bypass prevent_destroy without an explicit scope decision.

Verify EKS/node groups, NAT, ALB/target groups, billable IPs, EBS and other created resources after teardown. Show absent/retained/residual/unavailable with timestamps; failed inventory is not zero residual cost. Persist approvals and evidence outside the destroyed cluster. Agent proposal or a review of this skill cannot authorize live apply/destroy; perform the safe preparation first and request only the remaining specific authority when needed.

## Official implementation references

- Saved-plan automation: https://developer.hashicorp.com/terraform/tutorials/automation/automate-terraform
- Apply semantics: https://developer.hashicorp.com/terraform/cli/commands/apply
- S3 state/locking: https://developer.hashicorp.com/terraform/language/backend/s3
- GitHub AWS OIDC: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
- EKS pricing: https://aws.amazon.com/eks/pricing/

Verify current documentation and installed/provider APIs before version-sensitive implementation. These references establish behavior, not execution permission.
