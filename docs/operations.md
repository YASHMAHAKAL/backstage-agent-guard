# Operations and evidence

## Read status accurately

The portal separates configured target, verified release, approved proposal,
GitOps PR, Argo sync, and live workload observation. Each is a different
claim. A missing credential or inaccessible cluster produces an unavailable
observation, not a healthy deployment. The read-only observer does not merge,
sync, deploy, or call Gemini.

Observed demo evidence:

| Path                | What was observed                                                                                                                                      | Limit                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Local Kind service  | A reviewed GitOps PR was merged; Argo reported Synced/Healthy, one Node.js Pod was ready, and its internal HTTP check returned 200                     | This proves the local example service path, not AWS deployment             |
| Rizz.AI EKS staging | Frontend and backend Deployments each reported 1/1 ready; the browser reached the restricted ALB's self-signed HTTPS certificate and Basic Auth prompt | A successful Gemini response was not recorded                              |
| Teardown            | The operator reported completion on 2026-10-04                                                                                                         | Residual AWS inventory and final cost were not independently verified here |

## Secrets and access

Keep GitHub tokens, OAuth client secrets, Jev credentials, the Gemini key,
demo password, Terraform state/plans, and local cloud target files out of Git.
The application secret **value** is entered privately in AWS Secrets Manager;
Terraform manages its metadata and IAM, not the value. External Secrets copies
the value to the Kubernetes workload only when the controller and GitOps
resources are present. The portal's cloud read profile, release reader,
GitOps reader, GitOps writer, and Terraform operator have different authority.
Do not use one token as a substitute for another.

## Infrastructure lifecycle

The AWS Terraform roots are applied in dependency order:

```text
bootstrap (protected state bucket) → registry (ECR and publishing identity)
→ environments/staging (network, EKS, IAM, secret metadata)
→ argocd (Helm installation)
→ argo-bootstrap (GitOps connection, Applications and controller setup)
```

Teardown reverses the EKS-dependent stages after app Ingress and ALB cleanup:
`argo-bootstrap` → `argocd` → `environments/staging`. The protected state bucket
and ECR repositories may be retained. The runtime secret is deleted by a full
staging destroy unless an explicit reviewed retention scope excludes it. See
the [AWS teardown and recovery runbook](https://github.com/YASHMAHAKAL/backstage-agent-guard/blob/main/infra/aws/TEARDOWN.md)
for the dependency order, observed namespace/EIP failures, and residual
inventory checklist. A successful Terraform message alone is not zero cost.

The short demo constraints were a US$5 maximum budget, a four-hour checkpoint
from first resource creation, and teardown starting soon after verification.
The AWS budget sends alerts; it is not a hard spending limit.

## TechDocs publishing

This repository uses Backstage's **basic** TechDocs setup: `mkdocs.yml`, this
`docs/` directory, and the Catalog entity's `backstage.io/techdocs-ref`.
Backstage builds the site on demand and stores it locally. The development
profile uses Docker for generation; the backend image is configured to run
MkDocs locally. This is not a CI-published, externally stored production
TechDocs site. [Backstage's TechDocs guide](https://backstage.io/docs/features/techdocs/getting-started/)
recommends CI generation and external storage when the portal is deployed for
production use.
