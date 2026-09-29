# Short-demo teardown — not executed or authorized

No AWS resources were created by these local increments. User intent is to begin teardown within minutes of successful verification; deletion can take longer and charges continue until corresponding resources are removed.

## Evidence and scope

Capture both rollouts, approved image pair/source commit, merged revision, Argo sync and bounded functional test. Sanitize screenshots; never publish credentials, private plan/state or account metadata. Confirm intended non-root profile/region/cluster/backend/state key against inventory, not similar names or current kubectl context. Preserve Kind.

Review exact delete/retain scope: staging network/EKS/controller ALB, runtime secret, registry/images, budget, shared OIDC and protected state bucket. Intent to finish the demo is not authorization to destroy unspecified resources.

## Remove controller resources first

Freeze new releases and coordinate cloud-only GitOps deletion so Argo cannot recreate workloads. Review/merge removal of the app Ingress/resources while Argo and controllers still operate. Application deletion needs a reviewed cascading policy; deleting without cascade can orphan resources. Never indiscriminately delete the platform parent Application.

Verify Ingress plus actual AWS ALB/listeners/target groups/controller-owned security groups are gone. Inspect controller logs/finalizers/ENIs on failures. Keep controller IAM alive until cleanup finishes; do not force-remove finalizers or randomly delete ENIs. Failed ALB cleanup blocks normal cluster teardown and does not stop its charges.

Handle namespace/ExternalSecret cleanup; deleting Kubernetes Secret does not delete AWS secret. Record retention decisions without reading/exposing values.

## Review exact destroy plan

After verifying this root's backend/private inputs and receiving plan authority, future commands are:

```bash
terraform -chdir=infra/aws/environments/staging plan -destroy \
  -input=false -out=teardown.tfplan
terraform -chdir=infra/aws/environments/staging show teardown.tfplan
```

Plans/output can contain private metadata: keep local/ignored. Review all deletions/account/region; no routine `-target`, lock disabling, active-writer force-unlock or state removal. Do not destroy bootstrap/registry to resolve a staging dependency.

This root schedules runtime secret deletion with seven-day recovery; it does **not** retain the secret on destroy. If retention is required, stop and review a retention-safe ownership change first. Scheduled deletion prevents immediate name reuse. Obtain explicit authorization for the saved destroy plan; changed state/configuration/plan requires renewed review. Apply only that approved plan, with private backup/state recovery available. No auto-approve or automatic teardown script is supplied.

## Verify residual resources/cost

Check exact inventoried AWS resources, not just Terraform's completion:

- Cluster and workers/ASG gone; zero nodes alone still incurs EKS charges.
- NAT deleted/EIP released; controller ALBs/target groups/ENIs gone.
- Worker volumes deleted; inspect retained EBS volumes/snapshots/IPs separately.
- VPC/subnets/routes/security groups/endpoints removed when in approved scope; reconcile unexpected ownership, never wildcard-delete.
- Logs/Pod Identity/IAM removed according to plan; controller role cleanup separately tracked.
- Secret scheduled deletion/retention recorded, not claimed as immediate permanent deletion.
- ECR images/state versions/budget/shared OIDC explicitly retained or separately reviewed. ECR has no force-delete; tagged releases need an explicit decision.

Denied/timeouts mean unknown, not proof of deletion; billing can lag. Record UTC start/end and removed/retained categories/remaining charges. Recheck unexpected billable resources through approved scoped actions. Keep state bucket recovery; never empty/delete it just to finish the demo.
