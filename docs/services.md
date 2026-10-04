# Services and ownership

The Catalog names a **System** for a product, **Components** for running code,
and **Resources** for infrastructure targets. Catalog registration describes
ownership; it does not prove that a workload or cloud resource currently exists.

## Platform services

| Part                                                | Meaning and responsibility                                                                                                           | Owner                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Backstage frontend (`packages/app`)                 | Catalog, Agent Guard review, Rizz.AI Control Center, release/deployment pages, and TechDocs UI                                       | `platform-team`             |
| Backstage backend (`packages/backend`)              | Hosts Catalog, Scaffolder, authentication, TechDocs, search, Kubernetes reads, and the Agent Guard API                               | `platform-team`             |
| Agent Guard frontend (`plugins/agent-guard`)        | Shows proposals, exact file previews, policy reasons, approval decisions, and read-only delivery observations                        | `platform-team`             |
| Agent Guard backend (`plugins/agent-guard-backend`) | Validates bounded requests, stores snapshots/audit history, invokes Jev, checks review eligibility, and reserves private publication | `platform-team`             |
| Agent Guard permission module                       | Denies ordinary users direct protected Scaffolder execution; the backend publisher checks approved task claims again                 | `platform-team`             |
| Backstage MCP Actions                               | Exposes submission/status actions to an agent; it is not a Kubernetes or Terraform execution endpoint                                | `platform-team`             |
| Jev                                                 | Compares declared intent with the proposed change; its choice and score inform review but never grant authority                      | External assessment service |

The local service demo uses three platform-owned Scaffolder templates under
`catalog/templates/`: Node.js API, FastAPI service, and CronJob worker. They
render fixed staging manifests. `examples/template/` is Backstage starter
content, not one of these governed templates.

## Application and delivery services

| Part                         | Meaning and responsibility                                                                             | Owner                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Rizz.AI frontend             | React UI served through nginx; proxies application API calls to the private backend                    | `rizz-team`, in the Rizz.AI source repository                                          |
| Rizz.AI backend              | Express API using a server-side Gemini key; exposes private readiness and metrics endpoints            | `rizz-team`, in the Rizz.AI source repository                                          |
| Rizz.AI source CI            | Builds, tests, scans, and publishes a verified pair of immutable frontend/backend images to ECR        | Application source repository                                                          |
| ECR repositories             | Retain the two paired image streams; an image appearing in ECR is not a deployment                     | `platform-team`, Terraform registry root                                               |
| Private GitOps repository    | Holds reviewed Kubernetes desired state; merge is the release decision                                 | Human GitOps reviewers                                                                 |
| Argo CD                      | Watches the approved GitOps branch and reconciles the application and platform controller Applications | `platform-team` bootstrap, then Argo reconciliation                                    |
| External Secrets             | Syncs the approved AWS Secrets Manager value into the dedicated application namespace                  | Terraform installs controller through Argo; GitOps owns app SecretStore/ExternalSecret |
| AWS Load Balancer Controller | Creates and cleans up the ALB for the restricted application Ingress                                   | Argo-managed controller with platform IAM                                              |
| EKS staging                  | Runs Argo, controllers, and the application during the cloud demo                                      | `platform-team`, Terraform staging root                                                |

Terraform roots are separate: `bootstrap` protects the state bucket;
`registry` owns ECR/publishing identity/budget; `environments/staging` owns
network, EKS, IAM and secret metadata; `argocd` installs Argo CD; and
`argo-bootstrap` registers its Projects, Applications and private GitOps
connection. [Delivery workflows](delivery.md) shows when each is needed.
