# Terraform Argo CD bootstrap

This root installs the existing reviewed Argo CD chart on `rizz-eks-staging`.
Terraform owns the Argo Helm release and its upgrades. Its private service,
RBAC and resource settings are inline in the Helm values. The separate
[Argo bootstrap root](../argo-bootstrap/README.md) owns Projects and
Applications; Argo owns controller installations and application workloads.
This replaces the separate operator `helm install` step. It has not been
applied to a live cluster.

The AWS foundation must be applied and verified first. The Helm provider needs
an existing reachable Kubernetes API, so this root has its own state key:
`rizz-platform/argocd-staging/terraform.tfstate`. Installation after foundation
creation is a separate saved-plan operation, rather than attempting to initialize
Kubernetes providers while the cluster is still being created.

## Installation behavior

- Reads only the fixed EKS staging cluster in `us-east-1`, using the explicit
  reviewed profile/account. Rejects root, the wrong cluster/account, missing
  project/environment tags, and a cluster that is not active on EKS 1.35.
- Downloads the public chart with `fetch-argocd-chart.mjs` and checks its bytes
  against the existing chart lockfile. Terraform independently checks the digest.
- Installs `argocd` in its namespace with the existing private ClusterIP service,
  anonymous access disabled, empty default RBAC grants, and bounded resources.
- Gets fresh EKS authentication through `aws eks get-token`; it does not use or
  overwrite the default/Kind kubeconfig. No Argo API observer account or
  application API key is an input or output; Backstage reads the named
  Application CR through its separate EKS reader Role after bootstrap.
- Waits for workloads and jobs, with a ten-minute timeout. Installation failure
  remains visible for diagnosis. It never forcibly adopts an existing release.

The operator needs `eks:DescribeCluster`, existing EKS access, cluster network
reachability, and permissions to install the chart's Kubernetes objects. Before
any live operation, confirm cluster/node/add-on readiness and scoped backend
access. Copy the placeholder variable/backend examples into ignored private
files. Use the existing encrypted state bucket, native locking and reviewed
saved-plan process; this root does not authorize provisioning.

Existing operator policies scoped only to the registry/staging state keys do
not automatically cover the new Argo key. Prepare its state-object read/write
and `.tflock` read/write/delete permissions before creating paid EKS resources.
This configuration does not edit IAM policies or activate the runner.

If Argo already exists outside this Terraform state, reconcile ownership and
review importing `argocd/argocd` before managing it. Do not run a second installer.
The new root is not yet an allowed root in the Backstage Terraform runner; its
initial execution uses the existing approved operator process.

## Local checks without AWS

From the repository root:

```bash
node infra/cloud-platform/fetch-argocd-chart.mjs
terraform -chdir=infra/aws/argocd init -backend=false -input=false
terraform -chdir=infra/aws/argocd validate
terraform -chdir=infra/aws/argocd test
```

The first command downloads only a public chart into an ignored cache. Tests use
mocked AWS/Helm providers; they do not create a live AWS plan or touch Kubernetes.
They cover target/account/root rejection, missing/changed archive rejection,
private service/RBAC settings, and refusal to adopt unrelated releases.

## Remaining bootstrap and teardown ordering

This root automates Argo installation. After its CRDs are ready, the
[Argo bootstrap root](../argo-bootstrap/README.md) registers Projects and
Applications, supplies the private read-only GitOps connection, and waits for
platform controller health. Administrator credential rotation, HTTPS and the
approved Rizz.AI release remain separate. Successful Helm installation alone
is not an application deployment.

During authorized teardown, remove application Ingresses and verify controller
AWS cleanup first. Remove the Argo bootstrap root while EKS and Argo still
work, then destroy this Helm root while EKS access and the worker still exist.
Destroy the AWS foundation last. Keep registry and state retention decisions
separate.

Provider behavior: [HashiCorp Helm provider authentication](https://github.com/hashicorp/terraform-provider-helm/blob/v3.2.0/docs/index.md)
and [Helm release resource](https://github.com/hashicorp/terraform-provider-helm/blob/v3.2.0/docs/resources/release.md).
