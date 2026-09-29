# Rizz.AI platform architecture

## Scope and decision precedence

Approved design: extend the existing Agent Guard platform into a Rizz.AI lifecycle IDP on one AWS EKS staging cluster. Preserve the three Kind demonstration templates. Read `rizz-idp-lifecycle.md`, `rizz-idp-terraform.md`, and `rizz-idp-delivery.md` for the accepted lifecycle extension; those supersede earlier optional lifecycle/infrastructure scope. This reference specifies intended behavior; verify source, configuration, tests, and live state before claiming anything exists.

User decisions override this guide. Shared governance rules in `architecture.md` remain mandatory. Cloud-specific differences are: an existing third source repository, trusted build-derived images, an EKS target, a fixed reviewed frontend entry point, required lifecycle actions, and required platform-only infrastructure controls. Do not globally permit public ingress or arbitrary images on the local recipes.

Production, ECS, GCP, multi-region, application databases, Crossplane, and publicly hosting Backstage are not part of the first cloud milestone. Add them only through an explicit scope decision.

## Application baseline and discovery

The planning inspection of `https://github.com/YASHMAHAKAL/Rizz.AI` found:

- React/TypeScript/Vite frontend under `rizz-app/`, served by nginx.
- Express backend under `backend/`, calling Gemini using server-side `GEN_AI_KEY`.
- Same-origin frontend `/api` requests proxied to `rizz-backend-service:3000`.
- Browser-local and in-memory application state; no current application database requirement.
- Existing Dockerfiles, Kubernetes YAML, Terraform under `terraform/`, and `.github/workflows/deploy.yml`.
- A combined workflow building images, applying Terraform, and deploying directly with kubectl.
- Mutable/local image references, missing deployment hardening, an old EKS version, and legacy Gemini SDK/model configuration needing review.
- Default branch `master` during inspection; do not assume every repository uses `main`.

These observations may change. Reinspect source and workflow files before implementation. Do not infer deployed AWS resources from Terraform files or a README. Inventory actual resources, state location, ownership, and current deployments before migration. Never apply a fresh state against existing infrastructure blindly.

## Repository contracts

| Repository | Owns | Must not own |
| --- | --- | --- |
| Rizz.AI | App source, tests, Dockerfiles, app CI, release metadata, catalog descriptors, app docs | Routine cluster provisioning or direct cloud app deployment |
| backstage-agent-guard | Portal, Agent Guard, policy, templates, Terraform modules/environment configuration, platform CI/docs | Copied application source or live secrets |
| backstage-agent-guard-gitops | Desired Kubernetes state, immutable image references, Argo Applications, add-on manifests/configuration | Terraform state or plaintext credentials |

Use these target layouts as conventions; inspect existing paths before creating or moving anything:

```text
Rizz.AI/
  backend/                       # Existing Express application
  rizz-app/                      # Existing frontend
  .github/workflows/             # Test/build/publish, separate from infrastructure
  catalog-info.yaml              # System/components/API relationships
  docs/                          # Application documentation

backstage-agent-guard/
  catalog/templates/             # Existing demos + bounded cloud recipes
  infra/aws/bootstrap/           # State/identity bootstrap, if needed
  infra/aws/modules/             # Platform-owned modules
  infra/aws/environments/staging/ # Reviewed module configuration

backstage-agent-guard-gitops/
  apps/staging/                  # Preserve current Kind demos
  clusters/eks-staging/platform/ # Cloud add-ons, excluding their own bootstrap cycle
  clusters/eks-staging/apps/rizz-ai/
```

Moving existing Terraform to the platform repo requires a state-migration/import plan and a no-unintended-replacement review. Do not duplicate resources through a second Terraform root. Preserve existing frozen proposal file hashes and historical status records.

## Stack and resource ownership

| Layer | Initial choice | Owner |
| --- | --- | --- |
| Portal/governance | Existing Backstage, TypeScript/React, Agent Guard, official MCP Actions, Jev | Platform repo |
| App build | GitHub Actions, pinned dependencies, two container images | App repo |
| Image registry | Two ECR repositories; deployment by digest | Terraform creates; CI publishes |
| Cloud foundation | Terraform, VPC, EKS managed nodes, IAM/access entries, EKS add-ons | Platform infrastructure workflow |
| Terraform state | Encrypted/versioned S3 and supported state locking | Restricted bootstrap workflow |
| App desired state | Kustomize, explicit namespace, Deployments/Services/Ingress | GitOps / Argo CD |
| Public entry | Operator-IP-restricted ALB, temporary self-signed HTTPS, no purchased domain | GitOps Ingress; controller provisions ALB |
| Secret sync | Secrets Manager + External Secrets Operator | AWS secret metadata/IAM in Terraform; Kubernetes declarations in GitOps |
| Observability | Structured logs, metrics, right-sized Prometheus/Grafana or reviewed alternative | Explicit platform/add-on owner |

Terraform must not also manage an ALB owned by the ingress controller. Bootstrap Argo installation once; assign subsequent upgrade ownership clearly. Do not have Terraform Helm resources and Argo manage the same Helm release. Chart/provider/action/package versions are implementation-time pins, not floating `latest` values.

## AWS foundation

- One region and one staging cluster; confirm region, account, budget, and naming before provisioning.
- Two availability zones; private worker subnets with a documented egress design for Gemini/image pulls. Price NAT versus approved alternatives; a single NAT is a staging cost/availability tradeoff.
- Use an EKS version in standard support, compatible with the region, Terraform provider/modules, and add-ons. Do not reuse the inspected version 1.29. Verify current AWS support immediately before provisioning.
- Size managed nodes from measured requests for Rizz.AI, Argo CD, controllers, and monitoring. One node is acceptable for a cost-conscious demonstration but is not HA; two replicas do not create node-level availability.
- Restrict API endpoint access. Use private access or public access constrained to approved operator CIDRs. Document how the bootstrap operator or infrastructure runner reaches it; ordinary app CI does not need cluster access.
- Configure least-privilege IAM, EKS access, required add-ons, resource tags, encryption, and budget alerts.
- Bootstrap remote state and CI trust before dependent workflows. ECR repositories must exist before the first image push.
- Infrastructure plan/apply runs independently of app commits. Review actual plan artifacts before apply.

## Cluster and application topology

Suggested namespace names: `argocd`, `rizz-staging`, `external-secrets`, and `monitoring`. Names are platform configuration, never free-form agent targets. Use a dedicated Argo Application such as `rizz-ai-staging` with a restricted AppProject and exact repo/path/destination allowlists.

```text
Browser → HTTPS ALB → frontend Service → nginx/React
                                      └→ /api → backend ClusterIP → Gemini
```

Only the frontend ingress is public under this recipe. Backend Service is ClusterIP. No database, arbitrary ingress, or cloud resource is added by a release request. Display exposure clearly in the review UI; the public frontend is not a hidden implication of the word staging.

Use Kustomize first, CPU/memory requests and limits, non-root containers where feasible, dropped capabilities, readiness/liveness checks, safe rollout strategy, and consistent catalog/resource labels. Test Backstage's Deployment→ReplicaSet→Pod association. Do not change immutable selectors on existing workloads without a migration plan.

Declare any network-policy guarantees only after enabling and testing an enforcing implementation. Standard NetworkPolicy does not provide arbitrary FQDN filtering; do not claim a Gemini-only egress allowlist without an appropriate implementation.

## Identities and secrets

- App CI: GitHub OIDC role restricted to image publishing in the approved ECR repositories. Match the actual repo/workflow/branch token claims; no long-lived AWS access keys.
- Infrastructure CI: separate role and approval-controlled workflow; no unrestricted application-workflow access to this role. Choose enforceable gates supported by the GitHub account/plan; do not assume private-repo required-reviewer features exist.
- Argo: private GitOps repo credential with read-only scope; restrict deployment destinations and resource permissions.
- Backstage publisher: narrowly scoped GitHub credential/App installation; authority to publish an approved PR, not cluster-admin or infrastructure apply.
- Backstage Kubernetes/status access: authenticated read-only access to the intended namespaces/Argo endpoints. Local AWS-backed access requires renewable short-lived authentication; do not reuse a static Kind token for EKS.
- Secret operator: access only to the required secret, through a verified supported Pod Identity/IRSA configuration. Backend itself needs no AWS role just to consume an injected Kubernetes Secret.
- Gemini: secret stored in Secrets Manager, referenced by ExternalSecret and workload; no value in manifests, Terraform variables committed to Git, Jev prompts, image layers, logs, or frontend assets. Inspect the selected secret-management flow's state exposure.

Document rotation, refresh timing, and whether workloads need rollout to consume rotated environment variables. Use examples with placeholders, never personal credentials or account IDs.

## Backstage configuration and developer experience

Register one Rizz.AI System, frontend and backend Components, the backend API contract, owner groups/users, and meaningful infrastructure Resources. Choose actual existing authorized owner mappings; do not invent reviewer membership. App descriptors live with app source; avoid duplicate catalog ingestion of the same entity from GitOps.

The required Control Center and role migration are specified in `rizz-idp-lifecycle.md`. Routine Rizz.AI ownership moves to mapped `rizz-team`; shared infrastructure remains `platform-team`. This is a planned migration, not an assertion that these memberships or permissions already exist. Preserve historical platform-owned snapshots and reviewer rules.

Portal areas: ownership/source links, trusted releases, deployment form, Agent Guard review/diff, CI links, Kubernetes resources/events, read-only delivery status, metrics/log links, and TechDocs/runbooks. Both manual and MCP submission enter the same governed backend. Protected Scaffolder execution remains unavailable directly from `/create`.

Extend catalog discovery and status mapping for the cloud paths explicitly. The current local `apps/staging` discovery must remain supported. Resolve cluster/Argo Application from backend target configuration, not a user-provided URL. UI labels must distinguish Kind staging from EKS staging.

## Preserve local operation and defer optional work

Use separate local/cloud config overlays, credentials, GitOps paths, Argo Applications, and Kubernetes target mappings. Cloud config is opt-in and must not break local startup when AWS credentials are absent. Existing approved local proposals retain their original destination.

Backstage remains local initially. Hosting it in EKS is a separate milestone requiring durable PostgreSQL, persistent proposal/audit/Scaffolder state, secure auth/base URLs, backups and restore checks, restricted access, and migrations. This portal database does not imply an application database.

Crossplane is optional later for a real resource need, such as storage for a newly approved application feature. Define a bounded resource API, ownership, lifecycle/deletion policy, and reconciliation permissions first; pin compatible providers/functions/composition revisions. Never have Crossplane and Terraform reconcile the same resource or create an unused database merely to include the technology.
