# Backstage Agent Guard

A Backstage developer portal for reviewed GitOps delivery. An agent or developer submits a bounded proposal; Agent Guard validates and freezes the exact change, shows Jev's advisory intent assessment, and requires a different eligible reviewer. Approval opens a GitOps pull request. Human merge and Argo CD reconciliation are separate steps.

The repository supports two demo paths:

- **Local service demo:** platform-owned Node.js API, FastAPI service, and CronJob templates deploy through a private GitOps repository to Kind.
- **Rizz.AI lifecycle:** a verified frontend/backend image pair can be proposed for EKS staging, then observed, scaled within bounds, rolled back to a verified deployment, or retired through reviewed GitOps changes. Terraform manages AWS infrastructure separately.

The **Agent Guard** overview at `/agent-guard` lists authorized requests from both paths. Kind and Rizz.AI retain their separate proposal and review pages.

```text
Proposal → frozen files and policy → distinct Backstage review → draft GitOps PR
         → human repository review and merge → Argo CD → live observation
```

Application builds live in the [Rizz.AI source repository](https://github.com/YASHMAHAKAL/Rizz.AI). Kubernetes desired state lives in the private GitOps repository. This repository owns the portal, policy, templates, Terraform roots, and bootstrap configuration.

## Documentation

The reader-facing guides in `docs/` are also this repository's **Backstage TechDocs**. Open **Catalog → Backstage Agent Guard → Docs** in the local portal, or read them on GitHub:

- [Overview](docs/index.md)
- [Use the portal](docs/use-the-portal.md)
- [Services and ownership](docs/services.md)
- [Delivery workflows](docs/delivery.md)
- [Operations and evidence](docs/operations.md)

For detailed operator procedures, see the [Kind setup](deploy/README.md), [AWS infrastructure roots](infra/aws/README.md), and [AWS teardown and recovery](infra/aws/TEARDOWN.md). TechDocs uses Backstage's basic local builder: the development profile generates with Docker, while the backend image is configured to run MkDocs locally. A production portal should move generation to CI and use external storage.

## Run locally

Requirements: Node.js 22 or 24. Docker is needed for TechDocs generation and the optional Kind cluster.

```sh
node .yarn/releases/yarn-4.13.0.cjs install
node --env-file-if-exists=.env .yarn/releases/yarn-4.13.0.cjs start
```

Open <http://localhost:3000>. The default shared guest identity can browse and submit a proposal but cannot satisfy distinct human review. For a signed-in two-person demo, configure GitHub OAuth and separate mapped Backstage users, then run `node .yarn/releases/yarn-4.13.0.cjs start:github`. The [portal guide](docs/use-the-portal.md) explains the opt-in GitOps, Kubernetes, release, and cloud startup profiles. Keep tokens and secrets in ignored local files.

Configuration uses five main files: shared defaults, signed-in portal, Kind, cloud and production. Release and EKS settings share one ignored `app-config.cloud.local.yaml` override; the release-only command keeps EKS operations disabled. See the [configuration profiles](docs/use-the-portal.md#configuration-profiles) for setup and the command that enables both Kind and cloud views.

## What was demonstrated

A reviewed local GitOps PR was merged, Argo CD reported the service Synced/Healthy, its Pod became ready, and the internal HTTP check returned 200. The Rizz.AI EKS demo later showed one ready frontend and one ready backend Deployment and reached the restricted self-signed HTTPS login prompt. The operator reported teardown on 2026-10-04; this repository has not independently verified a zero-resource AWS inventory or a successful Gemini response. The Terraform runner contract exists but its automated AWS execution path is not activated. See [evidence and limits](docs/operations.md).

## Verify source changes

```sh
node .yarn/releases/yarn-4.13.0.cjs tsc
node .yarn/releases/yarn-4.13.0.cjs workspace @internal/backstage-plugin-agent-guard-backend test --watch=false --runInBand
```

The project-specific [Agent Guard skill](.agents/skills/backstage-agent-guard/SKILL.md) records the trust boundaries and acceptance criteria. Tests and catalog registration do not by themselves prove a live deployment.
