# Rizz.AI cloud observation: merge, rollout and HTTPS verification

Implemented locally, tested with synthetic transports. No AWS resources, live
PRs, Argo syncs, registry builds, credential creation or repository protection
changes were performed. Cloud governance and observation are **off by default**.
The installable manifest-check bundle is described in
[`infra/cloud-gitops/README.md`](../infra/cloud-gitops/README.md); it is not yet an
enforced required check in the actual GitOps repository.

## Backend and UI

Open `/rizz-deployments`, select a visible cloud proposal and click **Check cloud
delivery**. This invokes authenticated, user-scoped
`GET /api/agent-guard/rizz/proposals/:id/delivery`. Requesters and mapped platform
members can observe; strangers, guest and service callers cannot use this user
route. Authorization happens before provider reads. The GET never changes
proposal/version/approval/audit/task state or calls Jev, Terraform, sync or merge.

The observation independently checks:

- Stored frozen-snapshot integrity and its matching distinct-reviewer decision.
- The exact GitHub repository, PR number/URL, same-repo proposal branch and main
  base. Open/draft/closed-without-merge remains distinct from a merged PR.
- All nine app files/hashes at the immutable merge commit, using Git tree/blob
  integrity checks, not unpinned branch contents.
- The dedicated Argo app/project, repository, main branch, path, namespace and
  operator-pinned destination server, including its compared-to source/destination.
  Multi-source/custom source options, wrong destinations and comparison errors
  fail closed. There is no status request with `refresh` or sync side effect.
- Git ancestry **and exact approved file hashes at the actual Argo revision**.
  A later unrelated repo commit is acceptable if the app is unchanged. A changed
  app is mismatch, not falsely verified or automatically called superseded.
- Argo reported sync/health. Matching files + Synced + Healthy produce
  `synced_files_match`; this alone still does not verify delivery.
- Fresh non-root same-account AWS identity and the named ACTIVE EKS cluster's
  ARN, real endpoint and CA. Short-lived `aws eks get-token` credentials stay
  in memory for this read. No implicit kubectl context/kubeconfig, long-lived
  Kubernetes token, secret-value API or cluster mutation is used.
- Both exact reviewed Deployment specs, observed generations, desired/updated/
  available/ready replicas and conditions. Current ReplicaSets and ready running
  Pods must have matching controller UIDs, reviewed specs and running image IDs.
  Old/orphan/terminating/injected Pods, partial lists and rollout drift fail closed.
- Live Services/selectors/private backend, runtime ConfigMap, Ingress and
  SecretStore/ExternalSecret references/readiness. No plaintext Secret is read.
- Immutable ECR manifests with raw SHA-256 integrity. A runtime platform digest
  is accepted only as an executable Linux child of the approved parent index,
  after independently fetching/verifying that child. Attestation/config/layer
  digests are not equivalent. Manifest evidence is cached only within one read.
- Fresh AWS ALB/security-group/ACM preconditions and two HTTPS GETs to the
  backend-owned hostname: `/healthz` must return `{"status":"alive"}` and
  `/readyz` must return `{"status":"ready"}`. The latter traverses nginx to
  backend readiness. Hostname, certificate validity and exact reviewed peer
  fingerprint are verified. Redirects, unexpected JSON, HTTP errors and
  oversized bodies fail; TLS verification is never disabled.
- Workload/configuration and AWS target rechecks after smoke and a final Argo source/destination/
  revision check. A concurrent rollout/change invalidates the observation.

Only all four stages passing produces `deployed: true`. The UI shows replica/
generation evidence and a four-stage progress indicator. This is point-in-time
evidence, not continuous monitoring, an atomic distributed-system snapshot,
production readiness or successful Gemini inference. Kubernetes server defaults
are allowed; unreviewed commands/containers/env, privileged options and changed
reviewed fields are not silently accepted.

Historical artifact expiration does not invalidate an already frozen release's
integrity during observation; this does not relax fresh submission/execution
release checks. No retained old green result is reused after an outage. Each
response has `checkedAt`; there is no cache or continuous-monitoring claim.
Reads are bounded by a 45-second deadline and 2 MiB provider responses (4 KiB
smoke bodies); HTTPS also has an 8-second idle timeout. Errors
are sanitized. GitHub credentials never follow redirects. Argo HTTPS uses TLS
hostname/CA verification; a self-signed Argo endpoint needs its actual CA.
Only an explicit loopback port-forward may use HTTP; do not use remote HTTP or
disable TLS verification. Argo redirects/non-200/malformed responses fail closed.

## Configuration prerequisites (operator step, not performed)

In the ignored, filled cloud overlay, set `agentGuard.rizzCloud.delivery.enabled`
to true only after the dedicated EKS Argo is available. Supply:

- `argoCdUrl`: the dedicated cloud endpoint/port-forward, not Kind's endpoint.
- `argoCdToken`: a short-lived backend-only token for `rizz-observer`.
- `argoCdCaBase64`: actual Argo TLS certificate CA for its endpoint.
- `destinationServer`: exactly the generated cloud Application destination;
  dedicated in-cluster Argo currently uses `https://kubernetes.default.svc`.

The prepared Argo values now include an **apiKey-only** `rizz-observer` account
with `applications,get,rizz-app/rizz-ai-staging` only. Default role stays empty;
no sync, override, logs, exec, cluster or repository permissions are added. These
values have not been installed. An operator later generates/stores/revokes its
token without pasting it into chat or committing it. Argo's in-cluster alias is
not used to select the Kubernetes endpoint: the observer independently resolves
the explicit AWS EKS target and reads that cluster directly.

The backend's existing GitOps read token needs read-only private repository
contents/PR access. The cloud-reader profile additionally needs the read-only
target verification permissions in `rizz-ai-cloud-phase-4.md`, and
`ecr:BatchGetImage` on just the two Rizz staging repositories.
`eks:DescribeCluster` is scoped to the named cluster; token generation uses the
same explicit profile. Configured live observation now makes these read-only
AWS calls; implementation tests use fixtures, with no AWS or Gemini calls.

## Namespace-scoped Kubernetes authorization

The Argo bootstrap Terraform root owns the cloud observer Role and RoleBinding
in `rizz-staging`, outside the unprivileged app recipe. Its reviewed saved plan
must be applied after EKS and Argo exist. It permits exact-name GETs for
Deployments, Services, ConfigMap, Ingress and secret-sync objects, plus namespace
list access to those resource kinds, Pods and ReplicaSets for retirement
inventory. It grants no Secrets, node reads, logs, exec or write verbs. RBAC
does not enforce label selectors on those list permissions, so the reader can
list the dedicated namespace. The portal returns only bounded evidence, not
raw objects.

The same role permits GET proxy access to the named backend Service so the
Control Center can fetch `/metrics` through the Kubernetes API. This permission
is limited to one Service by name, but Kubernetes RBAC does not restrict the
proxied URL path. The observer calls only `/metrics`, parses fixed metric names
and labels, and returns bounded numeric aggregates to authorized app/platform
viewers. This is a sample from one selected backend replica; counters reset on
process restart and cannot be summed across replicas from this endpoint. A
failed read shows unavailable rather than zero. The public nginx frontend
returns 404 for `/metrics`.

The staging Terraform root creates the dedicated reader IAM role and EKS
STANDARD access entry mapping it to `rizz-cloud-observers`. The Argo bootstrap
root then creates the Role/RoleBinding. Do not associate cluster-admin policies,
use root or reuse the bootstrap admin profile. Neither root grants app GitOps
permission to edit RBAC. Keep Kind access separate. The backend needs network
access from the allowed operator IP to the EKS API and ALB.

## Still pending: live acceptance, not verification code

Provisioning, real access/RBAC/Argo credentials, workflow/merge-control
installation, a paired ECR build and authorized deployment/teardown remain
pending. Tests include real loopback TLS with ephemeral test keys, but AWS,
Kubernetes and registry data is synthetic. No live cloud success is claimed.
No observation calls inference; readiness means configuration/proxy readiness,
not Gemini quota or key validity.

References checked: [Argo Application specification](https://argo-cd.readthedocs.io/en/latest/user-guide/application-specification/),
[Argo API](https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/),
[Argo RBAC](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/), and
[GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
Additional references: [EKS token command](https://docs.aws.amazon.com/cli/latest/reference/eks/get-token.html),
[Kubernetes rollout](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/),
[Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/),
[ECR manifest reads](https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_BatchGetImage.html),
and [Node HTTPS](https://nodejs.org/download/release/latest-jod/docs/api/https.html).
