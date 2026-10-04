# Rizz.AI AWS demo teardown and recovery

This runbook covers the short-lived EKS staging demo in `us-east-1`. Keep the
local Kind demo separate. The demo constraints are a US$5 maximum budget, a
four-hour checkpoint from first resource creation, and teardown starting
shortly after successful verification. A budget alert does not stop charges;
deletion may continue beyond the checkpoint.

## Latest demo: 2026-10-04

The operator reports that teardown completed. The application Ingress and
Argo CD Application were removed, followed by the `argo-bootstrap`, `argocd`,
and staging Terraform roots. The staging teardown initially stopped after EKS
deletion because `rizz-platform` lacked `ec2:DisassociateAddress` for the NAT
EIP. Completion was reported after that failure; this document does not by
itself verify that every AWS resource is absent.

The `rizz-staging` namespace also stalled in `Terminating`: External Secrets
validation webhooks still referred to a Service that had been removed. After
the stale webhook configurations were cleared, `ExternalSecret/rizz-runtime`
still held the `externalsecrets.external-secrets.io/externalsecret-cleanup`
finalizer. The operator cleared that finalizer on the orphaned resource so
namespace deletion could finish. This was recovery from a partially removed
controller, not a routine teardown step. The Argo CD Helm uninstall also
reported that its CRDs were retained by chart resource policy; those cluster
CRDs cease to exist when EKS is deleted.

The intended retained scope is the ECR repositories/images, protected Terraform
state bucket, runtime Secrets Manager secret, and staging account guard. The
runtime secret was deliberately excluded from the staging deletion. Confirm
its actual AWS status and Terraform state before relying on that retention;
the latest teardown report alone is not an inventory check.

## Prepare a future teardown

Record the approved image pair, source commit, merged GitOps revision, Argo
sync/health, workload readiness, and bounded functional result. Keep private
plan/state, credentials, and secret values out of screenshots and committed
files. Confirm the exact AWS account, `rizz-platform` profile, region, cluster,
Terraform backend, and state key rather than trusting a current `kubectl`
context. Preserve the separate Kind cluster.

Freeze new cloud releases. Decide explicitly whether to delete or retain the
runtime secret, ECR images/repositories, budget, shared OIDC resources, and
state bucket. Do not include bootstrap or registry roots merely to resolve a
staging dependency. Preserve the state bucket while dependent roots need it.

## Delete in dependency order

1. Remove the Rizz.AI application Ingress while the AWS Load Balancer
   Controller and EKS API still work. Stop Argo CD from recreating it through a
   reviewed GitOps change or a reviewed Application removal. Check that the
   controller-owned ALB, listeners, target groups, security groups, and ENIs
   disappear. The Terraform-owned bootstrap Ingress can also keep the demo ALB
   alive; remove it while the controller is still running.
2. Remove the `argo-bootstrap` root's Argo Projects/Applications, repository
   connection, bootstrap Ingress, temporary ACM certificate, and public SSM
   target metadata. Let External Secrets clean up its custom resources before
   its webhook/controller is removed. Confirm namespaces finish terminating.
3. Destroy the `argocd` root while EKS access and workers still exist, so Helm
   can uninstall its release. Argo CD chart CRDs may be retained until the EKS
   cluster is deleted.
4. Destroy the staging foundation only after controller-owned AWS resources
   are gone. Keep the controller's IAM authority until its cleanup completes.
   The staging root owns the EKS cluster, network, NAT/EIP, IAM, and runtime
   secret metadata. A full destroy schedules that secret for deletion with a
   seven-day recovery window; it does **not** retain it automatically. If the
   secret must remain, review an explicit retention-safe scope and confirm the
   resulting state tracks it. Do not remove it from state merely to hide a
   failed deletion.

For each root, review a fresh exact destroy plan, its account/region, resource
addresses, and retained scope before applying it. A partial apply changes
state: inspect the result and create a new plan for remaining work. Keep saved
plans local and private. For example, a full staging destroy can be inspected
with:

```bash
terraform -chdir=infra/aws/environments/staging plan -destroy \
  -input=false -out=teardown.tfplan
terraform -chdir=infra/aws/environments/staging show teardown.tfplan
```

That full plan includes the runtime secret; do not apply it if retention is
intended. The project's governed Terraform control requires approval and
execution of the exact saved plan. A manual interactive destroy also requires
review of its proposed changes, but is not the governed runner workflow. Do
not use routine `-target`, lock disabling, force-unlock of an active writer, or
`-auto-approve`.
Targeting is a recovery tool for a reviewed partial teardown, as it was when
retaining the runtime secret in this demo.

## Recover a stalled deletion

- If a namespace remains `Terminating`, inspect its conditions and remaining
  resources. A missing External Secrets webhook Service can block deletion of
  `SecretStore` and `ExternalSecret` objects. Prefer restoring the webhook long
  enough for normal cleanup. If the controller is already removed, inspect the
  exact stale webhook configurations and custom resources before clearing
  them. Remove a finalizer only from a confirmed orphan after checking its
  cleanup responsibility and the AWS secret retention decision. Never strip
  namespace finalizers blindly.
- If staging destroy reports an AWS `AccessDenied`, stop and update only the
  required operator policy. For the observed NAT EIP failure, the missing
  action was `ec2:DisassociateAddress`. Recheck state and create a fresh plan;
  an EKS deletion success message does not imply the EIP or NAT is gone.
- If an ALB, ENI, target group, or finalizer remains, inspect the controller
  and AWS resource ownership before removing anything manually. A Terraform
  timeout, interrupted command, or released state lock does not prove cleanup.

## Verify the residual inventory

Record a timestamped AWS inventory as **absent**, **retained**, **residual**, or
**unavailable** for each item:

- EKS cluster, node groups/ASG, and worker volumes.
- ALB, listeners, target groups, controller security groups, and ENIs.
- NAT gateway, EIP/public IPs, VPC, subnets, routes, and network security groups.
- CloudWatch logs, Pod Identity associations, and staging IAM roles/policies.
- Runtime secret status and staging Terraform state entries; do not read or
  expose the secret value.
- Deliberately retained ECR images/repositories, budget, shared OIDC resources,
  and versioned state bucket.

Do not infer zero cost from an empty Terraform state or a successful destroy
message. AWS billing may lag, and an unavailable inventory is not proof that a
resource is absent. Keep teardown evidence outside the deleted cluster.
