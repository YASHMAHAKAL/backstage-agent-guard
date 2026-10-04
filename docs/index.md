# Backstage Agent Guard

Backstage Agent Guard is a developer portal that turns a proposed deployment
into a reviewed GitOps change. An agent or signed-in developer can ask for a
bounded change, but the proposal does not deploy anything. The portal validates
the request, shows the exact files and policy result, requires a different
eligible reviewer, and then opens a pull request. A repository reviewer makes
the separate merge decision; Argo CD reconciles the merged desired state.

The project has two independent paths:

| Path                     | What it demonstrates                                                                                     | Where it runs                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Agent Guard service demo | Three fixed templates: internal Node.js API, internal FastAPI service, and scheduled worker              | Local Backstage, GitOps repository, and Kind/Argo CD                     |
| Rizz.AI lifecycle        | Verified frontend/backend release pair, bounded runtime change, rollback and staged retirement proposals | Local Backstage portal; when provisioned, a separate EKS staging cluster |

The Rizz.AI application source, this platform repository, and the private
GitOps repository have separate owners and jobs. Application CI builds and
publishes images. Terraform owns AWS infrastructure and Argo bootstrap. The
portal creates reviewed GitOps proposals for application changes. Argo CD owns
the deployed Kubernetes application. [Services and ownership](services.md)
explains each part.

## Start here

- [Use the portal](use-the-portal.md) to run Backstage and submit a proposal.
- [Delivery workflows](delivery.md) to follow a proposal from review to a
  deployed service, or to understand where Terraform fits.
- [Operations and evidence](operations.md) for status, credentials, teardown,
  and the limits of the demonstrated behavior.

## What approval means

Backstage approval authorizes its private Scaffolder action to open a GitOps
pull request. It does not merge the pull request or declare a deployment.
Jev's semantic assessment is advisory; deterministic identity, scope and
snapshot checks decide whether execution is allowed. The agent cannot approve
its own request, run Terraform, or mutate Kubernetes through Agent Guard.

The cloud demo reached two ready Rizz.AI Deployments and the restricted HTTPS
browser sign-in prompt in October 2026. The operator later reported teardown.
Those observations do not establish a successful Gemini response or an
independently verified zero-resource AWS inventory. See
[Operations and evidence](operations.md) for the exact boundary.
