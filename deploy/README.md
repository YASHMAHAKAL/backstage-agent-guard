# Local GitOps bootstrap

This demo uses only the separate `agent-guard` Kind cluster. Always pass
`--context kind-agent-guard` to `kubectl`; other contexts on the host may point
to unrelated or remote clusters. Argo CD's Application watches `main`, not PR
branches. Backstage approval opens a PR; a human merge is the release gate.

The bootstrap was exercised on 2026-09-24 with Kind v0.33.0 and Argo CD
v3.5.3. Get the pinned Kind binary from the [official release instructions](https://kind.sigs.k8s.io/docs/user/quick-start/), then:

```sh
kind create cluster --name agent-guard --config deploy/kind/cluster.yaml --wait 180s
kubectl --context kind-agent-guard create namespace argocd
kubectl --context kind-agent-guard apply -n argocd --server-side \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.3/manifests/install.yaml
kubectl --context kind-agent-guard -n argocd rollout status deployment/argocd-repo-server --timeout=180s
kubectl --context kind-agent-guard -n argocd rollout status statefulset/argocd-application-controller --timeout=180s
```

The GitOps repo is private. Give Argo CD a GitHub **read-only deploy key** for
that repository; do not reuse the broad token that opens PRs. Generate an
Ed25519 key, add only its public half at GitHub repository Settings → Deploy
keys with write access disabled, and register its private half as an Argo CD
repository Secret. For example, with a key at an operator-controlled path:

```sh
kubectl --context kind-agent-guard -n argocd create secret generic agent-guard-gitops-readonly \
  --from-literal=type=git \
  --from-literal=url=git@github.com:YASHMAHAKAL/backstage-agent-guard-gitops.git \
  --from-file=sshPrivateKey=/path/to/read-only-deploy-key
kubectl --context kind-agent-guard -n argocd label secret agent-guard-gitops-readonly \
  argocd.argoproj.io/secret-type=repository
kubectl --context kind-agent-guard create namespace staging
kubectl --context kind-agent-guard apply -f deploy/argocd/staging-application.yaml
kubectl --context kind-agent-guard apply \
  -f deploy/kubernetes/backstage-kubernetes-reader.yaml
```

Protect and remove any temporary local private-key copy after verifying the
cluster Secret. Never commit it. A deploy key was already registered for the
current local cluster; do not repeat this step without checking the existing
key/Secret.

The last manifest creates a separate `backstage-kubernetes-reader` ServiceAccount
in `staging`. Its Role permits only `get`, `list`, and `watch` for the resource
kinds displayed by Backstage's Kubernetes tab; it cannot mutate workloads,
read Secrets, or access other namespaces. The Backstage startup command in the
[project README](../README.md#see-kubernetes-resources-in-backstage) creates a
short-lived token for it at runtime and does not store that token in Git.

Check the live state without exposing secrets:

```sh
kubectl --context kind-agent-guard -n argocd get application gitops-pr-demo-api
kubectl --context kind-agent-guard -n argocd get application gitops-pr-demo-api \
  -o jsonpath='{.status.sync.status}{"\n"}{.status.health.status}{"\n"}{range .status.conditions[*]}{.type}{": "}{.message}{"\n"}{end}'
kubectl --context kind-agent-guard -n staging get deployment,service
```

The shared Application source path is `apps/staging`. Its historical Kubernetes
object name remains `gitops-pr-demo-api` so this is an in-place migration, not
two Argo CD Applications managing the original workload. It uses directory
recursion and excludes `catalog-info.yaml` (a Backstage descriptor, not a
Kubernetes object) and historical `kustomization.yaml` files. This means each
merged, Agent Guard-generated service folder under `apps/staging/<service-name>`
is reconciled by the one platform-owned Application; no per-service Application
is needed. The existing `gitops-pr-demo-api` folder remains compatible during
the migration because its historical `kustomization.yaml` is excluded and its
concrete Kubernetes YAML files are still rendered.

Apply the updated Application manifest once to migrate a running cluster, then
wait for it to reconcile before approving a new service proposal:

```sh
kubectl --context kind-agent-guard apply -f deploy/argocd/staging-application.yaml
kubectl --context kind-agent-guard -n argocd wait \
  --for=jsonpath='{.status.sync.status}'=Synced \
  application/gitops-pr-demo-api --timeout=180s
```

PR #1 was merged after the cluster bootstrap. Argo CD's restricted project
intentionally cannot create Namespace resources, so the platform operator
creates the single `staging` namespace before sync. Verify `Synced`, the
individual workload health, and a Deployment's `Available` condition (or a
worker Job completion). Do not interpret the shared Application's `Healthy`
field alone as proof that every workload succeeded. If PR contents need
changing, submit a **new** Agent Guard proposal and approval; never edit an
approved PR branch under its existing approval digest.

For the Backstage read-only status view, the AppProject also grants a narrow
`agent-guard-status` role `applications get` on this shared Application. A 30-day
role token and the public Argo CD TLS certificate are stored in this workspace's
ignored, mode-`600` `.env.delivery.local` file. This is not an admin token and
it does not grant sync or mutation permissions. The backend connects through a
loopback-only port-forward and verifies the Argo CD server certificate. See
[the project README](../README.md#see-deployment-status-in-backstage) for the
two-terminal startup commands. If the cluster is recreated, its certificate
and project role token must be refreshed; never commit either credential.
