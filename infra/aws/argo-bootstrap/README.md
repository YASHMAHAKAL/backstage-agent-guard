# Terraform Argo Projects, Applications and repository connection

This root owns the two bootstrap namespaces, the closed Argo `default` project,
the `rizz-platform` and `rizz-app` projects, three Applications, the private
read-only GitOps repository connection and a fixed-response ALB bootstrap
Ingress. It does not install Argo CD itself or apply Rizz.AI workload
manifests. The Argo Helm root must be applied first so
its `Application` and `AppProject` CRDs exist **before this root is planned**.
Terraform's Kubernetes provider queries custom-resource schemas at plan time.

The fixed target is `rizz-eks-staging` in `us-east-1`. AWS and Kubernetes
providers use only the named operator profile, expected account and fresh EKS
exec credentials. The root has a separate S3 state key and does not use the
current kubeconfig. It has not been applied to any cluster.

## Repository credential

The only private input is `TF_VAR_gitops_read_token`, supplied from an ignored
operator environment at **both** saved-plan creation and apply. The token must
be a read-only fine-grained token for only
`YASHMAHAKAL/backstage-agent-guard-gitops`. The Kubernetes provider's
`data_wo` field and Terraform's ephemeral variable keep its value out of
Terraform plan/state. Do not put it in `.tfvars`, an action log or a shell
command line. To rotate it, update the private input and increment the reviewed
`gitops_credential_revision`. The revision is visible in plans; the token value
is not. Because the value is ephemeral, the operator must verify the same
reviewed credential source remains available through apply.

Argo owns the two pinned public Helm chart installations through its platform
Applications. Terraform owns only the Application objects and their values.
Both platform Applications automatically sync without automatic pruning;
Terraform waits for them to become `Synced` and `Healthy`. The Rizz.AI
Application also syncs automatically without pruning. Its GitOps path is
absent until the first approved Backstage PR is merged, so Argo will report a
source error before that merge. This does not make the Terraform apply a
successful app deployment. The first PR creates the nine application files,
including SecretStore and ExternalSecret; subsequent PR merges update them.

After the Load Balancer Controller becomes healthy, the Terraform-managed
`rizz-alb-bootstrap` Ingress creates the ALB with an operator-IP-only HTTP
listener returning fixed 503. It exposes no app workload. **The ALB is billable
even though the Terraform plan shows only a Kubernetes Ingress.** Its DNS name
is an output. The operator can then create/import the hostname-matched
self-signed ACM certificate privately and configure the reviewed Backstage
target. The first app PR adds a separate HTTPS-only Ingress in the same fixed
IngressGroup and enables HTTP-to-HTTPS redirect; Argo owns that app Ingress.
The bootstrap Ingress remains during releases. For staged retirement, first
merge the reviewed app Ingress removal and perform the documented Argo sync
with pruning. Then review a separate plan setting `enable_alb_bootstrap=false`;
applying it removes only this fixed-response Ingress while the controller is
still running. Verify the ALB and target groups are gone before completing the
retirement check. This switch is a retirement operation; normal app releases
do not require a Terraform plan.

The Argo `default` project is created by Argo at startup. The declarative
`import` block adopts only that existing project, then closes it. If it is
absent or already managed by another state, stop and reconcile ownership
before applying. Do not force-create or import an unrelated object.

## Local checks, no AWS

```sh
terraform -chdir=infra/aws/argo-bootstrap init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/aws/argo-bootstrap validate -no-color
terraform -chdir=infra/aws/argo-bootstrap test -no-color
```

The mock tests do not prove live Kubernetes schema compatibility, GitOps
token scope, controller readiness, ALB behavior or AWS authority. Before any live plan,
verify Argo and its CRDs, actual target identity, EKS access and state key
permissions. Review the saved plan under the platform Terraform controls.
Neither these instructions nor the code authorize provisioning or deployment.

During approved teardown, retire the app Ingress first and remove the
bootstrap Ingress with the reviewed switch above. Verify ALB deletion while
the controller is running. Remove this root before uninstalling the Argo Helm
release, and remove that release before the EKS foundation. Keep registry and
state retention separate.

References: [Terraform custom-resource plan ordering](https://developer.hashicorp.com/terraform/tutorials/kubernetes/kubernetes-provider#managing-custom-resources),
[Kubernetes `kubernetes_manifest` import/wait](https://github.com/hashicorp/terraform-provider-kubernetes/blob/v2.38.0/docs/resources/manifest.md),
[Kubernetes Secret write-only data](https://github.com/hashicorp/terraform-provider-kubernetes/blob/v2.38.0/docs/resources/secret_v1.md),
[Argo declarative repository credentials](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/).
