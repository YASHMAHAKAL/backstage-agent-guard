# Cloud platform bootstrap preparation

Read-only rollout/smoke verification is implemented in the backend. Prepared
namespace observer RBAC lives in `observer/rbac.yaml` and must be installed only
after explicit EKS reader access review; it is not part of an app release or
automatically installed here. See [cloud observation prerequisites](../../docs/rizz-ai-cloud-observation.md).

Local-only configuration, not an installation. No AWS/kubectl/Argo call is made by `prepare.mjs`. It generates bootstrap objects or invokes **only `helm template`** on checksum-verified downloaded archives. It never installs a chart, publishes Git, retrieves secrets or provisions resources. Existing Kind apps are unchanged.

## Prepared versions and ownership

Official chart indices checked 2026-09-26:

| Component | Chart / app | Owner |
| --- | --- | --- |
| Argo CD | 10.9.2 / v3.5.3 | Separate [Terraform Helm bootstrap root](../aws/argocd/README.md); no Argo self-management |
| AWS Load Balancer Controller | 3.5.0 / v3.5.0 | Argo platform Application; IAM/Pod Identity remain Terraform |
| External Secrets Operator | 2.11.0 / v2.11.0 | Argo platform Application; IAM/secret metadata remain Terraform |

`charts.lock.json` stores official archive URLs/hashes; renderer rejects altered bytes. Tests render against Kubernetes 1.35.0 and validate custom resources using CRD schemas from those exact charts. This is not a live EKS compatibility/security-scan result. Chart dependency images use exact upstream version tags, **not** independently resolved digest pins. Argo's Helm source pins the chart version but does not enforce this local archive checksum during reconciliation; trust/review upstream or mirror reviewed packages before stronger supply-chain claims.

Argo server is ClusterIP/TLS, no ingress/anonymous access, empty default RBAC grants, operator admin only. Rotate bootstrap admin credentials privately; no public portal or SSO is configured. Dex/notifications disabled. This chart always renders ApplicationSet; replicas zero keeps it inactive, not absent. No HA. Resource requests/limits are explicit, including Redis init job; measure actual usage/allocatable node capacity before deployment.

Generated bootstrap contains two namespaces, a closed default project, distinct platform/app projects and three Applications. Apps are **manual sync initially**, no automated prune or cascading deletion finalizer. Do not blindly change those lifecycle choices to finish setup. Platform project is privileged (CRDs/webhooks/cluster RBAC) and only platform operators may change it; ordinary app requests cannot reach that authority. App project has no cluster-resource, Role/RoleBinding or directly managed Secret authority.

AppProject restricts repo/namespace/resource kinds, **not Git directory or image/Ingress parameter semantics**. The app Application fixes `clusters/eks-staging/apps/rizz-ai` on `main`, but trusted repo writers/admins can still change it. Review branch/path changes, protect GitOps writes, and retain Agent Guard frozen-file validation. The cloud proposal golden path and Kubernetes enforcement are not implemented by this increment.

## Offline verification

From the platform repository after installing its dependencies:

```bash
node infra/cloud-platform/prepare.test.mjs
node infra/cloud-platform/prepare.mjs infra/cloud-platform/config.example.json
```

First command runs fixture checks and intentionally skips chart rendering unless a chart directory is supplied. Second prints dummy bootstrap YAML, **not deployable configuration**. Examples never contain real account/network credentials. Copy the three reviewed public archives named `<chart>-<version>.tgz` into a temporary directory, using URLs in the lockfile. Then:

```bash
RIZZ_CHART_TEST_DIRECTORY=/absolute/path/to/downloaded-charts \
  node infra/cloud-platform/prepare.test.mjs
node infra/cloud-platform/prepare.mjs \
  infra/cloud-platform/config.example.json /absolute/path/to/downloaded-charts
```

The latter prints counts only. Local test prerequisites: Node, workspace `yaml`/`ajv` dependencies and Helm (tested with 4.3.0). No AWS credentials needed. Re-render before upgrading; chart values are not portable between arbitrary releases.

## Future installation gates and sequence

No command below is authority to provision or deploy. Follow [AWS gates](../aws/README.md), approved exact plan/budget/window and [teardown](../aws/TEARDOWN.md) first. Real image publishing/release verification, domain/ACM/HTTPS, authenticated owner/reviewer choices and cloud proposal path remain prerequisites for an app release.

1. Provision only reviewed AWS foundation after explicit authorization. Confirm EKS node/add-ons ready, exact account/region/cluster and operator access. Use a separate cloud kubeconfig/context; **never current-context implicitly**. Verify endpoint/access entry against Terraform outputs. Keep Kind credentials/config unchanged.
2. Fill ignored `config.local.json` with verified account/VPC/repo metadata. Reject credentials/extra fields. Inspect generated bootstrap privately; writing it to GitOps is a separately authorized reviewed operation. Desired handoff path: `clusters/eks-staging/platform/bootstrap.yaml`; not `apps/staging`.
3. Install the checksum-verified Argo chart once through the separate [Terraform Argo root](../aws/argocd/README.md), after EKS/node/add-on readiness. It reuses `values/argo-cd.yaml`, authenticates explicitly to EKS and waits for pods/jobs. This replaces the direct Helm operator installation; do not use both owners. Existing unmanaged releases require reviewed ownership reconciliation/import. Keep admin/repo credentials out of command arguments/output/screenshots. Access via an explicit-context loopback port-forward; do not create a public LoadBalancer for Argo.
4. Apply only reviewed bootstrap to that EKS context; create app namespace before ESO namespaced RBAC. Install project-scoped, read-only GitOps authentication privately. App repo builds and Backstage must never receive Argo administrator credentials. Changing the default project is safe only on this newly dedicated Argo installation, not the existing Kind instance.
5. Manually sync ESO and ALB controller separately. Wait for CRDs/webhooks/Deployments ready before creating custom resources or Ingress. Explicit VPC/region prevents IMDS discovery; SA names must match Terraform Pod Identities. Check pod credential behavior privately, never dump identity token/env. Test controller access; local policy validation does not prove AWS IAM authorization.
6. Operator stores runtime JSON in Secrets Manager using its secured console/private workflow: keys `gen-ai-key`, `demo-username`, `demo-password`. Do not put values in Terraform, CLI arguments, YAML, Jev or images. Review password strength and provider limits; no Gemini call is needed for readiness.
7. `secrets/runtime.yaml` is the app recipe fragment; hand it off to the future approved cloud GitOps app path, not apply it independently as a second owner. Wait for SecretStore/ExternalSecret Ready and required key **presence**, not print values. Scope watches to `rizz-staging`; IAM reads one AWS secret. No auth/jwt/role field is set: ESO uses its controller Pod Identity, not service-account impersonation/static credentials.
8. Only after verified image pair, approved generated manifests/PR merge and controller/secret/HTTPS gates, activate app reconciliation. Enable app automated sync through a reviewed platform change when ready so future human PR merges drive delivery; do not enable platform auto-prune casually. No end-to-end cloud release is possible yet.

## Rotation, webhook TLS and cleanup

Secret refresh is five minutes; `deletionPolicy: Retain` avoids erasing the last Kubernetes value if AWS source disappears, so explicitly inspect Ready/staleness. `creationPolicy: Owner` gives ExternalSecret ownership; deleting it can garbage-collect its generated Secret. This does not prevent workloads retaining old environment values. Update Secrets Manager, wait for refresh, then review a rollout of the backend to consume rotated env values. Missing provider/config must never be called a successful deployment.

ALB Application ignores only generated TLS Secret data and webhook CA bundles, with `RespectIgnoreDifferences=true`; all controller/RBAC/workload changes stay visible. First sync creates these fields, subsequent sync should preserve live values. Live repeat-sync/rotation still requires testing. ESO cert controller manages its own webhook; this increment does not ignore ESO workload or secret differences globally.

Remove app Ingress and confirm real ALB deletion **while controller/Argo/IAM are alive**. Then follow the exact reviewed destroy plan. Shared ELB service-linked role may remain; registry/state retention and seven-day runtime-secret recovery are separate decisions. These modules have never been installed, so no cleanup occurred.

Sources: [AWS controller installation/Pod Identity/TLS caveat](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/installation/), [ESO Secrets Manager](https://external-secrets.io/latest/provider/aws-secrets-manager/), [Argo installation](https://argo-cd.readthedocs.io/en/stable/operator-manual/installation/). Versions/values also verified against downloaded official chart archives, not inferred from generic examples.
