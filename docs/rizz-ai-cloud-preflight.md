# Rizz.AI AWS demo: preflight and spending review

Prepared 2026-09-27. This is an operator checklist, not an apply authorization or a claim that AWS is deployed. Keep Backstage and the existing Kind demo local. The cloud application uses a separate EKS cluster in `us-east-1`.

## Short-demo cost model

Estimate the entire paid window: foundation creation, controller bootstrap, first image publication, ALB/certificate setup, release review, rollout, verification **and deletion**. Taking it down minutes after success does not make setup time free. Use a two-to-four-hour planning window, not a promise that provisioning will finish within that time.

| Component                 | Quantity / assumption                                                     | Approximate hourly planning cost |
| ------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| EKS                       | One cluster under standard support                                        | $0.1000                          |
| Linux EC2                 | One on-demand `t3.large`, Standard credits                                | $0.0835                          |
| NAT                       | One zonal NAT; processing is extra                                        | $0.0450                          |
| ALB                       | One ALB; capacity units are extra                                         | $0.0225                          |
| Public IPv4               | Assume NAT + two ALB addresses                                            | $0.0150                          |
| EBS                       | One 20 GiB gp3 volume; $0.08/GiB-month assumption, 730-hour approximation | $0.0022                          |
| **Illustrative baseline** | All above present for the same hour                                       | **$0.2682/hour**                 |

Sources reviewed: [EKS pricing](https://aws.amazon.com/eks/pricing/), [T3 Linux Northern Virginia rates](https://aws.amazon.com/ec2/instance-types/t3/), [VPC/NAT/IPv4 pricing](https://aws.amazon.com/vpc/pricing/), [ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), [EBS pricing](https://aws.amazon.com/ebs/pricing/). The public NAT page's example is Ohio; the gp3 value is an example rate. Both remain **regional verification gates**, not certified Northern Virginia SKU quotes. Confirm the selected SKUs in the AWS calculator or price list before apply. ALB base/capacity examples and address counts are planning assumptions, not a maximum bill.

The baseline is approximately $0.54 for two hours, $1.07 for four hours, or $6.44 for 24 hours. These are arithmetic illustrations, **not all-in quotes**. NAT/ALB partial-hour billing, traffic/LCUs, cross-AZ traffic, CloudWatch ingestion/storage, ECR image storage, Secrets Manager/API calls, S3 state requests/version retention and tax are additional. More addresses or replacement nodes can increase cost. No free-tier/credits are assumed. Gemini and Jev charges are separate; health/readiness checks do not call Gemini.

User-approved decision (2026-09-27): **US$5 maximum AWS demo budget**, with a **four-hour checkpoint from first resource creation**. Four hours is a checkpoint, not permission to spend past $5 or extend the run automatically. This decision does not authorize apply or destruction and is not a spending guarantee or automatic shutdown. Start cleanup promptly after successful verification under separately reviewed cleanup authority. If setup fails, the allowance is at risk, or the checkpoint is reached, stop feature/debugging expansion and request a scoped cleanup decision; do not keep retrying indefinitely. Budget alerts are delayed notifications, not a hard cap. Allow headroom for deletion time and additional charges; never treat the baseline estimate as a live meter.

The Terraform budget is an account-wide monthly alert, not a project-only real-time limit. Retained ECR images, state versions and logs can continue charging after EKS removal. Record those separately.

## Evidence required before a real plan/apply

| Gate                  | Required evidence                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity              | Explicit `rizz-platform`; expected account privately supplied; authenticated non-root caller. No default/root fallback.                                                         |
| State and ownership   | Actual state location for all three roots; project/legacy resource reconciliation. Existing resources are not silently recreated, adopted or deleted.                           |
| Compatibility         | EKS 1.35 standard support in the region; exact available AL2023 AMI and compatible versions for all four add-ons. Example placeholder pins cannot be used.                      |
| Access                | Reviewed operator IPv4 `/32` for EKS and ALB; explicit operator IAM principal. No open-to-world workaround if home IP changes.                                                  |
| Release prerequisites | Review local Rizz.AI source/workflow changes before publication; replace the old direct-deploy workflow safely. ECR/OIDC must exist before a real trusted image-publishing run. |
| Review/observation    | Actual distinct platform-team reviewer mapping; separately reviewed reader IAM/EKS access and observer RBAC. Prepared RBAC files do not grant access by themselves.             |
| Secrets/TLS           | Operator-controlled Gemini value outside Terraform/Git; two-stage imported self-signed ACM/ALB DNS procedure; trust/fingerprint configured before a ready release target.       |
| Spending              | Accepted numeric allowance, run window, alert recipient, resource retention decision and scope-specific teardown procedure.                                                     |
| Authorization         | Human reviews actual saved plan for each root and explicitly authorizes that unchanged plan. A mock plan, status flag or chat “continue” is not an apply gate.                  |

The [bounded preflight](../infra/aws/scripts/preflight.mjs) checks the exact new/legacy ECR and EKS names, VPC Name tags, publisher role, GitHub OIDC metadata and proposed state bucket. It only calls metadata operations with the fixed profile/region and emits sanitized status labels. Access denied/timeouts are unknown. A present bucket requires ownership/state reconciliation; 404 does not prove bucket-name availability. `safeToReviewPlan` only permits further **human plan review**; `inventoryComplete: false` explicitly records that this is not a full inventory.

Untagged/renamed resources, other IAM roles, runtime secret metadata, ALBs, NAT gateways, volumes, IPs and actual Terraform state need additional scoped reconciliation. Never conclude the account is empty from a passing bounded check. Do not request or print secret values for inventory.

Supply `RIZZ_AWS_EXPECTED_ACCOUNT_ID` and `RIZZ_AWS_STATE_BUCKET` through a private operator environment (never in committed examples). The ignored `.env.aws.local` is the local input file; fill its blank fields privately. Confirm the account against the intended AWS console account, not just whatever credentials authenticate. It contains no access keys. Then, after confirming the intended target, the read-only command from the project root is:

```bash
node --env-file=.env.aws.local infra/aws/scripts/preflight.mjs
```

If private inputs are missing, the script exits before making AWS calls. Do not derive the expected account from whichever default credentials happen to work; compare with the intended account privately.

## Ordered live handoff — requires separate authorizations

1. Complete read-only inventory, verify regional pins/prices, record accepted budget and retention, and review protected local inputs/state ownership.
2. Review then explicitly authorize state-bootstrap saved plan. Keep state backups private; verify bucket encryption/versioning/ownership before dependent backend initialization.
3. Review then explicitly authorize registry/OIDC/budget saved plan. Verify trust/permissions and remote locking; publish the reviewed app CI changes only with repository-write authorization. Build the first real paired immutable release.
4. Review then explicitly authorize EKS/network saved plan. Verify nodes/access/add-ons; install the prepared Argo/controllers through separately scoped bootstrap authority. Do not make an app template run Terraform.
5. Configure runtime secret and read-only observer identities without exposing values. Perform the documented ALB/certificate bootstrap, configure the ready target, install/review GitOps policy controls and real reviewer mappings.
6. Agent or manual form submits a paired-release proposal → Jev evidence → distinct review → frozen Scaffolder PR → human merge → Argo sync → both real rollouts and HTTPS smoke verified.
7. Capture sanitized evidence and promptly review/authorize cleanup. Remove controller-owned ALB while controllers still run, then apply the exact approved staging destroy plan. Check residual charges/resources and record retained items.

Use the [foundation gates](../infra/aws/README.md), [ALB procedure](rizz-ai-alb-demo.md), [observer setup](rizz-ai-cloud-observation.md) and [scoped teardown](../infra/aws/TEARDOWN.md). This checklist adds no mutation command, scheduled cleanup or live provisioning claim.
