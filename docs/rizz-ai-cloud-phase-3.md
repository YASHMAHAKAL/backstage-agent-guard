# Phase 3 — bootstrap preparation and short-demo cost review

Prepared locally on 2026-09-26; **not provisioned**. This is the first foundation increment, not completion of Phase 3.

## Implemented and verified

- Separate protected state-storage and remote-state registry/IAM Terraform roots under `infra/aws`.
- Versioned/encrypted/private TLS-only state bucket; native S3 locking configured for registry state. Real locking/recovery remain untested until authorized provisioning.
- Two immutable ECR repositories, no forced image deletion, untagged-only cleanup; tagged approved/rollback releases retained.
- Exact GitHub OIDC subject/audience; support for name-only or verified immutable-ID subjects. Explicit shared-provider reuse versus creation; no blind default creation.
- ECR-only app publisher role, no cluster/state/IAM management/deletion authority. Trust gates repository/branch, not workflow file; branch writers remain trusted.
- Budget alerts with required private numeric amount/email; account-wide monthly notifications, not a hard cap.
- Non-root/wrong-account guards, private Terraform inputs/state/plans ignored; pinned AWS provider 6.66.0 and provider lockfiles.
- Read-only bounded metadata preflight script; no secret reads, sanitized status output, denied/unknown not treated as absent. The live script was not executed.

Both roots passed Terraform validate and fmt. Mock-provider tests: three bootstrap runs and six registry runs passed. Five preflight fixture tests passed. No real AWS API inventory, plan, apply, import, state migration, image push or live Gemini call occurred. Existing Kind paths/configuration were not changed.

At the end of this first increment, EKS/VPC were still future work. The second increment below adds their local code. Legacy Rizz Terraform is not copied/applied as a second owner. Read [the infrastructure runbook](../infra/aws/README.md) before any cloud operation.

## Second increment — EKS/network code and teardown preparation

Prepared locally on 2026-09-26, still **not provisioned**:

- Isolated staging state root; two-AZ network, private workers, single NAT/EIP and S3 gateway endpoint.
- EKS 1.35 standard support, private endpoint and `/32`-restricted public API; explicit operator access, no app-CI cluster authority.
- Single AL2023 t3.large worker, encrypted gp3 disk, IMDSv2, standard CPU credits, fixed scaling and required AMI release pin.
- Four exact managed add-on pins, dedicated CNI Pod Identity, runtime secret metadata/read-only ESO identity; no secret values in Terraform.
- Defined Terraform/Argo/controller ownership and [scoped teardown procedure](../infra/aws/TEARDOWN.md), including ALB removal before destroying controllers and seven-day runtime-secret recovery.

Staging Terraform validate passes; 10 mock plan tests pass for configuration and unsafe-input rejection. Examples deliberately require compatible version selection; mock versions are synthetic, not verified recommendations. No real AWS inventory/plan/apply, live provider call or deployment occurred. Existing local demo code/configuration was not changed.

Argo bootstrap, controller chart pins/manifests, ALB IAM role, real image publishing/paired release adapter, cloud golden path and observers remain unfinished. Phase 3 is not complete. See [staging details](../infra/aws/environments/staging/README.md). Numeric budget/domain/reviewer and exact regional version/capacity checks remain gates before provisioning.

## Third increment — local Argo/controller preparation

Prepared locally, not installed: pinned/chart-checksummed Argo bootstrap values, load-balancer and ESO Applications, separate restricted projects/closed default, runtime ExternalSecret recipe and dedicated ALB Pod Identity/IAM. Renderer calls only offline `helm template`, never Kubernetes/AWS. All Applications start with manual sync until reviewed prerequisites are complete; app automation must be activated later. Local GitOps/app source repositories were not modified by this increment.

Verified: nine preparation tests including all three actual chart renders and custom-resource checks against their pinned CRD schemas; eleven staging Terraform mock tests. No live IAM/controller/TLS/secret-sync validation has happened. Chart dependency images retain upstream exact tags, not independent digest verification. See [bootstrap runbook](../infra/cloud-platform/README.md) and [policy provenance](../infra/aws/environments/staging/policies/NOTICE.md).

Real publishing/paired release adapter, cloud recipe/governance/observers, domain/certificate decisions and all AWS provisioning/installation remain unfinished. No paid API calls, deployments or charges were initiated.

## User runtime intent and preliminary estimate

User wants a successful deployment check followed by teardown starting within minutes, not an always-on environment. The full billable window includes provisioning, installing controllers, first build/pull/sync, verification and deletion—not just those final minutes. No numeric maximum budget has been approved.

Illustrative full architecture: EKS standard support, one Linux t3.large worker (8 GiB, final capacity measurement pending), one zonal NAT, one small ALB, about three public IPv4 addresses, 20 GiB gp3, low demo traffic and small retained registry/state/secret/log footprint. No autoscaled second node, default heavyweight monitoring stack or EKS Auto Mode surcharge is assumed.

| Component                                    | Reference rate / assumption                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EKS standard-support control plane           | $0.10/hour, [EKS pricing](https://aws.amazon.com/eks/pricing/)                                                                                                                   |
| One t3.large Linux worker, Northern Virginia | $0.0835/hour displayed on the [official T3 page](https://aws.amazon.com/ec2/instance-types/t3/); CPU-credit surplus can add cost                                                 |
| One NAT gateway                              | $0.045/hour planning input plus processing; [VPC page](https://aws.amazon.com/vpc/pricing/) uses Ohio for its example, so recheck the exact Virginia SKU before approving a plan |
| One ALB                                      | $0.0225/hour plus $0.008/LCU-hour in the [US-East-1 example](https://aws.amazon.com/elasticloadbalancing/pricing/)                                                               |
| Three public IPv4 addresses                  | $0.015/hour combined at $0.005/address/hour, [VPC pricing](https://aws.amazon.com/vpc/pricing/)                                                                                  |
| 20 GiB gp3                                   | Roughly $0.0022/hour using the $0.08/GB-month [EBS example](https://aws.amazon.com/ebs/pricing/); regional SKU must be rechecked                                                 |

These inputs total about **$0.27/hour before variable/ancillary charges**, not an exact calculator quote. NAT and ALB round partial hours up, so a minutes-long test is not necessarily billed for minutes on every service. NAT processing, image downloads, cross-AZ/Internet transfer, CPU-credit bursts, registry/state/log/secret retention and taxes are additional. Free-tier/credit eligibility is not assumed. New domain purchases and Gemini usage are excluded.

For a prepared **2–4 hour total cloud window**, a practical planning allowance is **$1–3 AWS spend**, not a cap or guarantee. A **$5–10 agreed contingency limit** would provide headroom for troubleshooting; exceeding the chosen limit requires reassessment rather than silently continuing. Budget alerts may arrive late and cannot enforce that limit. A prolonged failed rollout or retained infrastructure can materially increase spend.

## Cost-aware execution order, only after authorization

Finish local template/release validation and teardown runbooks before starting EKS/NAT/ALB. Bootstrap state/registry/trust first, then build the verified image pair; avoid running a paid cluster while debugging CI. Review the concrete EKS plan/SKUs and the numeric budget/run window before apply. Verify both rollouts and one explicitly bounded live provider request; capture portfolio evidence, then review/start teardown promptly after confirmation. Remove controller-owned ALBs first while their controllers still operate, destroy the approved node/cluster/NAT scope, release remaining addresses/volumes and check residual billable resources. Decide separately what registry/state/secrets to retain.

An intent to take the demo down is not authorization to destroy an unspecified resource set. Exact teardown scope still needs review. No infrastructure is running from this work, so no teardown has been performed.
