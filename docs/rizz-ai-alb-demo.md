# Rizz.AI restricted ALB and temporary HTTPS

The demo uses the AWS ALB DNS name, an imported temporary self-signed ACM
certificate, and one reviewed operator public IPv4 `/32`. There is no purchased
domain. The backend stays ClusterIP. The first Rizz.AI release is requested in
Backstage and deployed by Argo after its reviewed GitOps PR is merged.

## One-time ALB bootstrap

AWS assigns an ALB DNS name after creating the ALB, but the self-signed
certificate needs that name in its SAN. The
[Terraform Argo bootstrap root](../infra/aws/argo-bootstrap/README.md)
therefore creates a separate `rizz-alb-bootstrap` Ingress after the controller
is healthy. It uses the fixed `rizz-staging-demo` IngressGroup and an HTTP 80
listener restricted to the operator `/32`. It returns fixed 503 and does not
route to Rizz.AI. The controller creates the billable ALB. Its real DNS name is
a Terraform output and must be verified against AWS; the name cannot be
predicted from the chosen load-balancer name.

After obtaining that DNS name, generate a private two-day certificate with
`infra/cloud-platform/alb-demo.mjs certificate ready OBSERVED_ALB_HOSTNAME`.
Import it privately into ACM. The helper makes local files only; it never
imports a key or changes AWS. Protect and remove the private key after the
reviewed import. Configure the ignored Backstage cloud target with the exact
DNS name, ACM ARN, SHA-256 certificate fingerprint and operator `/32`. The
target reader verifies the account, cluster, ALB, IP rules, certificate bytes
and the bootstrap HTTP listener before a first release can be proposed.

The approved first Backstage PR generates a separate `rizz-frontend` Ingress
for HTTPS 443 in the same IngressGroup. It includes the reviewed certificate,
the operator `/32`, and HTTP-to-HTTPS redirect. Argo applies it after merge.
Its frontend Service and app workloads are GitOps-owned; Terraform owns only
the fixed-response bootstrap Ingress. The target reader and rollout observer
then require the HTTPS listener, healthy Pods, secret sync, expected image
digests and HTTPS smoke checks. The fixed-response listener must never be
counted as app readiness. No manual `kubectl apply` is part of this flow.

The ALB can still incur charges before the first app release. The $5 AWS
maximum and four-hour checkpoint from first resource creation constrain every
reviewed plan, including this Kubernetes Ingress's AWS side effect. Neither
this document nor source code authorizes a live apply.

## Cleanup

Retire the app Ingress first with a reviewed Argo sync with pruning while the
controller is running. Then apply a separately reviewed `argo-bootstrap` plan
with `enable_alb_bootstrap=false` and verify ALB, listeners, target groups and
security groups are gone before destroying the controller/EKS. Detach and
delete only the demo ACM certificate under the reviewed teardown scope. Remove
the local certificate trust and key bundle. Registry and state retention are
separate decisions.

The actual listener, certificate, and group behavior remains unverified on
live EKS. Local tests check the generated app Ingress, target-reader rejection
paths, and Terraform configuration with mocked providers.

Sources: [AWS Load Balancer Controller listener and IngressGroup behavior](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/),
[ACM import requirements](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate-prerequisites.html).
