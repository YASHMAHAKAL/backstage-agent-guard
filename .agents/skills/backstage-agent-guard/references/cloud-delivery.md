# Cloud implementation, acceptance, and operations

This is the foundation roadmap. The accepted IDP completion sequence is in `rizz-idp-delivery.md`; lifecycle controls and platform-only Terraform controls are required scope. Existing phases remain dependency guidance, not a reason to defer those deliverables or rerun completed increments.

## Begin each implementation increment

1. Inspect worktree, existing tests/configuration, skill references, and actual repo branches. Preserve unrelated changes. Identify the requested phase and report observed versus planned capability.
2. Inspect Rizz.AI read-only before source work; locate or request its checkout. The Backstage workspace does not grant unrestricted writes to a sibling/private repo. Follow the available sandbox permissions and user scope.
3. Select a small verifiable increment. Updating this skill is not permission to implement all phases, publish artifacts, call paid services, or provision AWS.
4. Before cloud mutations, confirm account/region, resource scope, budget, existing state/resources, environment/exposure, and execution authorization. Never print tokens or unredacted environment files for diagnostics.
5. Verify relevant local behavior and bypass cases first. Report fixtures, mocked integration, real API calls, and actual deployment evidence separately.

## Phase 0 — Inventory and decisions

Inspect app source, CI, Kubernetes YAML, Terraform roots/provider locks/state, existing AWS resources, registry, catalog ingestion, local Argo paths, identities, and current observer implementation. Confirm AWS account/region/budget, frontend domain/HTTPS approach, owner/reviewer groups, GitHub gating capability, state location, and CI credential design before provisioning.

Deliver a migration/ownership map and cost estimate. Existing app CI must not keep directly deploying alongside Argo. Safely retire its infrastructure/apply and kubectl portions only when the replacement path and rollback are ready. Do not recreate existing resources from untracked state.

## Phase 1 — Application readiness locally

- Run both existing components locally without copying source into Backstage.
- Introduce supported/pinned runtime and Gemini SDK/model settings; verify official compatibility before choosing versions. Produce lockfiles and reproducible dependency installs.
- Harden Docker build contexts with `.dockerignore`; prevent `.env`/credentials in image layers. Run non-root with compatible nginx ports and filesystem needs.
- Add process liveness and configuration readiness. Avoid Gemini calls in probes or restart loops caused by provider outages.
- Add input validation, provider timeouts, bounded retries, request-size/concurrency/rate controls, and an explicit access strategy before public exposure. Local browser credits are not backend quota protection.
- Add tests, sanitized structured errors/logs, and correct UI error behavior; friendly fallback responses must not hide API failures from observability.
- Render cloud manifests locally with resources, probes, security settings, and labels.

Exit evidence: both containers work together; API routing and failure paths pass tests; manifests validate. Live Gemini tests require permission and a small declared usage bound, not an unlimited retry loop.

## Phase 2 — Catalog and trusted release pipeline

Register System/components/API/owners/docs. Implement source CI tests, container builds, scanning policy, ECR publishing by trusted identity, paired immutable release records, retention, and Backstage read-only release selection. Mock registry behavior until authorized ECR/bootstrap is available; label mocked results accurately.

Exit evidence: a successful trusted build resolves to both immutable images from the same commit. Unknown/failed/expired/untrusted releases cannot be selected for execution. App CI has no Terraform apply or Kubernetes deployment permission.

## Phase 3 — Reviewed AWS foundation

Bootstrap encrypted/versioned/locked state and CI trust, migrate existing state if needed, review Terraform plan, and provision only with authorization. Create EKS/ECR/IAM/network/secrets metadata and required add-ons. Install Argo once with a defined upgrade owner and private repo access. Configure secret synchronization and restricted cluster/status access. ECR creation precedes the first real publishing run; phases 2 and 3 may be coordinated without faking that dependency.

Exit evidence: remote state locking works; reviewed plan matches the target; cluster/add-ons are ready; Argo can read only intended repo paths; backend secret is available without exposure; budget alerts exist. Document single-node availability limits and actual estimated costs.

## Phase 4 — Governed release golden path

Implement `deploy-rizz-ai` schema, trusted release resolution, explicit EKS target mapping, deterministic rendering, frozen digest/preconditions, Jev compact semantic context, distinct review, private Scaffolder execution, PR checks, and cloud-specific observation. Manual and MCP submissions use the same gate. Preserve existing local policies/snapshots and label target clearly.

Exit evidence: agent proposal → authenticated distinct review → one GitOps PR → human merge → Argo sync → both workload rollouts → smoke verification. Verify real resources rather than status text alone. No cloud deployment happens before PR merge.

## Phase 5 — Operations and portfolio evidence

Add dashboards for latency/error/request/provider behavior, sanitized logs, deploy/runbook links, and read-only delivery timestamps. Size monitoring to available worker capacity; do not install a large default monitoring stack on an undersized node and call it healthy.

Demonstrate rollback through Git, provider failure handling, stale/unavailable observer behavior, and local demo regression. Capture architecture, tests, successful cloud release, semantic mismatch, policy rejection, recovery, and teardown evidence. Resume/blog claims must match observed results; do not claim HA, production readiness, verified original user intent, or Jev security guarantees.

## Required IDP extension

Application Control Center, deploy/runtime-change/rollback/retirement operations, application/platform authorization, operational views/readiness evidence, and platform-only Terraform request/plan/approve/apply/destroy controls are required. Follow the three `rizz-idp-*` references for implementation and acceptance. One deploy executor or a mock UI does not complete the project.

## Deferred milestones

- Hosting Backstage in EKS with durable PostgreSQL, backed-up state, authenticated restricted access, and tested restore/migration.
- Existing-app onboarding recipe after the first golden path proves reusable.
- Crossplane for an actual new resource API with separate ownership and deletion policy; no Terraform overlap or unused infrastructure.

## Required regression and negative tests

| Case | Required behavior |
| --- | --- |
| Existing Kind demos without AWS configuration | Still start, submit, review, publish, and observe with original destinations |
| Agent/manual direct Scaffolder REST/UI/MCP/dry-run bypass | Cannot publish protected files without valid task-bound approval |
| Self-review, guest, unauthorized owner/target | Server-side deny; hidden buttons are not the control |
| Replica count 3, float, wrong type, unknown field | Deterministic rejection; no clamp, cloud action, or Jev enforcement claim |
| Arbitrary image/repo/path/cluster URL | Reject before execution |
| Failed/untrusted release, mismatched build pair, missing digest | Hold/reject; no mutable tag fallback |
| Intent says private frontend but public recipe proposed | Semantic discrepancy visible; normal approval does not silently ignore it |
| Jev unavailable/conflicting/ambiguous | Accurate advisory state; no silent normal progression |
| Release/target/template/file changes after review | Approval invalid; no execution |
| Concurrent update to reviewed application files | New preview/review, not silent overwrite |
| Retry after external timeout | Recover known result idempotently; at most one PR per proposal |
| Open/unmerged PR | No deployment claim |
| New Argo revision with altered app files | Not verified as the old release; show superseded when appropriate |
| Argo/Kubernetes/GitHub unavailable | Stale/unavailable observation; no refreshed false success |
| Frontend ready but backend fails | Whole application not verified delivered |
| Pod image ID uses architecture-specific manifest | Verify legitimate registry relationship without false mismatch |
| Terraform plan/source/state changes | Replan and renew actual-plan authorization |

Test sensitive material exclusion in Git, screenshots, build context, artifacts, Jev state, and logs. Verify Deployment/ReplicaSet/Pod matching on both app components, including after rollout.

## Cost and teardown

Estimate control plane, nodes, NAT/egress, ALB, EBS, registry, secrets, DNS and logs; price current region rather than promising a fixed cheap total. AWS budgets alert; they are not a hard spending cap. Default development stays on Kind. Paid environments and billable provider tests need a bounded run window/usage plan.

Do not tear down merely because a demo ends. With explicit authorization, review the exact destroy scope and plan. Remove controller-owned load balancers while controllers still operate, handle dependent Kubernetes resources, then destroy the approved AWS foundation. Protect retained state/images/secrets according to the agreed retention decision; do not indiscriminately delete the state bucket. Verify residual ALBs/NAT/EBS/IPs and other billable resources. Stopping nodes alone does not stop EKS control-plane charges. Record what was removed and retained.

## Official source map and currency checks

Design recorded 2026-09-26. Reopen current official docs and check installed versions before implementing version-sensitive features. These links are verification sources, not permission to provision resources.

- Backstage catalog model: https://backstage.io/docs/features/software-catalog/descriptor-format/
- Templates: https://backstage.io/docs/features/software-templates/
- Hosted portal: https://backstage.io/docs/deployment/k8s/
- Existing MCP/permission/Jev sources: `sources.md`.
- EKS versions: https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
- EKS endpoint access: https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html
- AWS controller: https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
- Pod Identity: https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html
- Terraform state/locking: https://developer.hashicorp.com/terraform/language/backend/s3
- Terraform automation: https://developer.hashicorp.com/terraform/tutorials/automation/automate-terraform
- Exact saved-plan apply: https://developer.hashicorp.com/terraform/cli/commands/apply
- GitHub AWS OIDC: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
- External Secrets AWS: https://external-secrets.io/latest/provider/aws-secrets-manager/
- Gemini SDK: https://ai.google.dev/gemini-api/docs/libraries
- Gemini lifecycle: https://ai.google.dev/gemini-api/docs/deprecations
- Argo automated sync: https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/
- AWS cost: https://aws.amazon.com/eks/pricing/
- Optional Crossplane: https://docs.crossplane.io/latest/composition/compositions/

Select/pin supported versions and verify compatibility during implementation. Do not embed live credentials or account-specific values in this skill.
