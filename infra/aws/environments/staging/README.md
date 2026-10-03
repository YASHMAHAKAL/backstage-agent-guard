# EKS staging Terraform foundation

Apply requires explicit review of a saved plan. Live environment status belongs
in the dated operator launch record. Mock tests do not establish permissions,
regional availability, capacity, compatibility or deployment success. Existing
Kind configuration is separate.

## Configuration

- Fixed `us-east-1`, `rizz-eks-staging`, isolated S3 key `rizz-platform/eks-staging/terraform.tfstate`, encryption/native locking. Backend account/bucket/profile inputs remain private.
- Two AZs, two public ALB/NAT subnets and two private worker subnets. One NAT/EIP, S3 gateway endpoint; no automatic instance public IPs. Single NAT is not HA and second-AZ traffic can incur cross-AZ costs.
- EKS 1.35, standard support, private endpoint plus public endpoint restricted to reviewed individual IPv4 `/32`s. Changing home IP requires reviewed configuration, never opening access to the Internet.
- One AL2023 `t3.large` by default, worker minimum one and maximum two, encrypted 20 GiB gp3, IMDSv2/hop limit one, no SSH. The reviewed `capacity.auto.tfvars.json` pins desired workers to one; a later platform configuration PR may set two only after measuring Argo/controller/app requests, rollout headroom and cost. T3 standard credits avoid surplus-credit charges but can throttle sustained CPU use. No HA/autoscaler/Auto Mode.
- Mandatory exact AMI release and four managed add-on versions. Examples deliberately contain invalid placeholders; synthetic test versions are not recommendations.
- Separate cluster, worker, CNI and secret-sync roles. Standard AWS managed CNI permissions are not a custom least-privilege EC2 policy. Pod trust binds cluster/namespace/service-account tags. Only the explicit operator gets cluster-admin; app publisher gets no EKS access entry.
- Metadata-only `rizz/staging/runtime` secret, default AWS-owned encryption, seven-day deletion recovery. Secret operator reads only this secret; no secret version/value in Terraform. Customer KMS keys would require separate policy review.
- Three-day control-plane API/audit/authenticator logs. Default EKS API-data encryption is separate from encrypted worker disks; no additional KMS key created.

## Ownership and order

### Optional Backstage observer

`cloud_reader_enabled` defaults to `false`. A separately reviewed saved plan can
create `rizz-staging-cloud-reader`, its inline read policy and a STANDARD EKS
access entry mapping it to `rizz-cloud-observers`. Trust names only the existing
reviewed operator principal, with one-hour sessions. No EKS access policy is
associated. The later Argo bootstrap Terraform root installs the restricted
namespace Role and RoleBinding before using the `rizz-cloud-reader` role profile.
It grants no Kubernetes Secret reads or writes. Do not substitute the bootstrap
administrator profile.

The EKS group mapping follows [AWS's RBAC access-entry guidance](https://docs.aws.amazon.com/eks/latest/userguide/access-policies.html).
Certificate tag conditions are supported by [ACM's authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_acm.html).

AWS reads cover the named EKS cluster, tagged staging ACM certificates, the two
staging ECR manifests, and regional EC2/ELB metadata required by the real cloud
readers. Regional describe permissions expose more metadata than this one app;
there is no IAM, secret-value, inference or mutation permission. The separate
ECR-only release catalog role remains owned by the registry root. Configure the
operator's scoped `sts:AssumeRole` grants and private profile settings only after
review; enabling this variable does not grant the operator role-management rights.

This opt-in code does not itself install RBAC, configure the portal, deploy an
application or authorize a Terraform apply. See the dated launch card for live
demo status; the preparation statements below describe the original module work.

| Component                                            | Owner                                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Network/EKS/workers/access/IAM/secret metadata       | Terraform, this root; never app release CI                                                                                                |
| CNI, kube-proxy, Pod Identity Agent, CoreDNS         | Terraform EKS managed add-ons; no competing Helm owner                                                                                    |
| Argo CD                                              | Separate [Terraform Helm bootstrap root](../../argocd/README.md); owns installation/upgrades after EKS readiness, no Argo self-management |
| Load Balancer Controller / External Secrets Operator | Terraform-managed Argo platform Applications; Argo owns Helm installations                                                                |
| SecretStore/ExternalSecret/Rizz workloads            | Backstage-generated GitOps PR, then restricted Rizz Argo Application                                                                      |
| Secret values                                        | Authorized operator in Secrets Manager; never Terraform/Git/Jev                                                                           |

Verify cluster/node/access first, bootstrap Argo, configure read-only private GitOps credentials and constrained AppProjects, install controllers, test identity/secret sync, then deploy application Ingress. Use `external-secrets/external-secrets` to match the Terraform Pod Identity. Operator port-forward is initial Argo access, not public ingress.

Argo settings live in the separate Helm root; bootstrap namespaces,
AppProjects and Applications live in the separate
[Argo bootstrap root](../../argo-bootstrap/README.md). This foundation root
prepares a dedicated ALB-controller Pod Identity and narrowed versioned IAM
policy. These new Terraform roots have not been applied to a live cluster;
the earlier operator installation was torn down.
Verify actual ESO Pod Identity behavior and the cloud release path before
claiming deployment. Terraform must not also own controller-created ALBs.

Pre-compute add-ons and CNI Pod Identity depend on working reconciliation/identity-agent scheduling; CoreDNS follows the worker. Mock tests do not prove live ordering. Inspect live conditions during authorized provisioning; do not attach CNI permissions to all nodes ad hoc to hide a failed bootstrap.

## Before a real plan

Follow the [parent gates](../../README.md): numeric budget/window, account/state/legacy reconciliation, domain/HTTPS/access and reviewer decisions, scoped authorization. Confirm EKS support, available AZs, non-overlapping CIDR and exact compatible AMI/add-on pins in `us-east-1`. Example **future authorized read-only** queries:

```bash
aws eks describe-addon-versions --profile rizz-platform --region us-east-1 \
  --kubernetes-version 1.35 --addon-name vpc-cni
aws ssm get-parameter --profile rizz-platform --region us-east-1 \
  --name /aws/service/eks/optimized-ami/1.35/amazon-linux-2023/x86_64/standard/recommended/release_version \
  --query Parameter.Value --output text
```

Repeat add-on query for `kube-proxy`, `coredns`, `eks-pod-identity-agent`, verify compatibility and fill ignored private inputs. Verify node AMI architecture/release too; do not automatically accept a moving recommendation. These queries were not executed here.

After backend verification and separate authorization, generate/review a saved real plan for this root. Inspect resource counts, IAM/access, actual regional prices and teardown readiness. Apply only with authorization bound to the exact unchanged plan. Mock success grants no apply authority.

Local checks, no AWS APIs:

```bash
terraform -chdir=infra/aws/environments/staging init -backend=false -input=false
terraform -chdir=infra/aws/environments/staging validate
terraform -chdir=infra/aws/environments/staging test
```

Read [teardown](../../TEARDOWN.md) before provisioning. Sources checked: [EKS versions](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html), [endpoint access](https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html), [Pod Identity trust](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html), [session tags](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-abac.html), [default encryption](https://docs.aws.amazon.com/eks/latest/userguide/envelope-encryption.html), [AMI metadata](https://docs.aws.amazon.com/eks/latest/userguide/retrieve-ami-id.html).
