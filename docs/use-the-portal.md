# Use the portal

## Run Backstage locally

Use Node.js 22 or 24 from the repository root:

```sh
node .yarn/releases/yarn-4.13.0.cjs install
node --env-file-if-exists=.env .yarn/releases/yarn-4.13.0.cjs start
```

Open `http://localhost:3000`. The default guest profile is useful for browsing
the Catalog and submitting a local proposal. It cannot complete the distinct
reviewer requirement because every guest session has the same identity.
TechDocs appears under **Catalog → Backstage Agent Guard → Docs**. The basic
TechDocs setup generates this repository's Markdown on demand; its configured
generator needs Docker available to the Backstage backend.

**Agent Guard** at `/agent-guard` is the request overview. It combines the Kind
service and Rizz.AI proposal histories visible to your signed-in identity.
Filter by your requests, requests awaiting your review, or workflow. Each row
opens the appropriate detailed review page. With the cloud profile off, mapped
users can still see authorized Rizz.AI history, but cloud actions and detailed
cloud review remain unavailable.

For two-person review, configure the GitHub sign-in profile with two separate
GitHub accounts mapped to Backstage users. Copy
`examples/github-users.example.yaml` to the ignored
`examples/github-users.yaml`, set each account's immutable GitHub user ID,
and provide `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` privately.
Then run:

```sh
node .yarn/releases/yarn-4.13.0.cjs start:github
```

`TYPESAFE_API_KEY` is needed for a real Jev assessment. Keep it and GitHub
tokens in ignored local environment files. Do not place them in catalog
descriptors, documentation, proposal text, or GitOps manifests.

`start:github` uses the shared signed-in portal Catalog and loads only `.env`.
It needs no AWS credentials or cloud target. The Rizz.AI source entries use
a sibling checkout at `../Rizz.AI`; missing source files appear as Catalog
ingestion errors rather than preventing GitHub sign-in.

## Submit an Agent Guard service proposal

1. Open **Agent Guard → New Kind request**. Choose the internal Node.js API,
   FastAPI service, or scheduled worker. Enter the service name, existing
   owning group, staging inputs, and what you want changed.
2. Inspect the rendered files, scope checks, Jev assessment, and approval
   digest. A different authenticated member of the owning group reviews the
   frozen snapshot. A changed request needs a new review.
3. After approval, the guarded Scaffolder action opens a GitOps pull request
   when the private publishing connection is configured. A human reviews and
   merges it. Argo CD then applies it to the local Kind staging cluster.
4. Refresh the delivery observation. A pull request, Scaffolder task, or Argo
   badge alone is not proof that the workload is ready.

Without publishing configuration, the approved task renders files only. The
three platform templates are intended to be executed through Agent Guard's
approved task, not directly from Backstage's generic Create page.

## Use the Rizz.AI pages

`start:portal` loads the separate Rizz.AI source checkout and the private
GitOps integration. It requires the real GitHub sign-in configuration. The
release browser and cloud proposal target share an opt-in cloud profile:

| Command                                                       | Adds                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal`            | Rizz.AI Catalog and Control Center                                     |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:kind`       | Read-only local Kind Kubernetes view                                   |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:releases`   | Read-only verified release browser; explicitly disables EKS operations |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:cloud`      | Cloud proposals and observation                                        |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:cloud:kind` | Cloud profile and the independent read-only Kind Kubernetes view       |

## Configuration profiles

Backstage's standard loader merges a shared base and the profiles selected
by `BACKSTAGE_ENV`. The startup commands above select these profiles for you.

| File                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `app-config.yaml`            | Shared defaults and the guest Kind demonstration             |
| `app-config.portal.yaml`     | GitHub sign-in, GitOps integration and the signed-in Catalog |
| `app-config.kind.yaml`       | Optional read-only Kind connection                           |
| `app-config.cloud.yaml`      | Release discovery and EKS settings, disabled by default      |
| `app-config.production.yaml` | Production database, URLs and TechDocs overrides             |

The portal profile defines the signed-in Catalog locations once. It includes
all four guarded templates; registering the cloud executor does not enable
cloud operations or allow direct Scaffolder execution. Kind and cloud profiles
add connection settings without replacing that Catalog list. Production
reuses the portal's GitHub auth block through Backstage's `$include` support.

For releases or cloud operations, create the one ignored override:

```sh
cp app-config.cloud.local.yaml.example app-config.cloud.local.yaml
chmod 600 app-config.cloud.local.yaml
```

Fill in the source repository and ECR repositories for release browsing.
Cloud operations additionally require the AWS account, private GitOps
repository, operator CIDR and reader identities described in
[Delivery workflows](delivery.md). Set `rizzCloud.enabled` and, when configured,
`rizzCloud.delivery.enabled` to `true` only in this private file. The release-only
command forces both cloud flags off even if the file enables them, so release
browsing works without a running EKS cluster or GitOps reader token.

Provide `RIZZ_RELEASE_GITHUB_TOKEN` and `RIZZ_GITOPS_READ_TOKEN` privately in
the process environment, for example by sourcing `.env.rizz-cloud.local`
before selecting a release/cloud command. GitOps publishing uses the distinct
`GITHUB_TOKEN` from the ignored delivery environment file. Never put token
values in the committed profiles or copy private overrides into the backend
image.

When migrating an existing installation, combine the `agentGuard` blocks
from the old release and cloud local files into `app-config.cloud.local.yaml`.
Remove the old cloud file's `catalog` override: the portal profile now owns
those locations. The old profile names and files are no longer selected by
the startup commands.

The Terraform runner's `app-config.rizz-terraform.yaml.example` remains a
separate opt-in example. None of the portal commands selects that profile.

Backstage loads profile `.local.yaml` files after the committed profiles,
and `APP_CONFIG_` overrides have the highest priority. Configuration arrays
are replaced rather than appended. Validate the selected configuration with
`backstage-cli config:check`; see the
[official configuration guidance](https://backstage.io/docs/conf/writing/).

These commands start the **local portal**. They do not provision EKS or
deploy Rizz.AI. The cloud page at `/rizz-deployments` proposes a verified
frontend/backend pair and bounded lifecycle changes only when its private
target, identity and release inputs are configured. See
[Delivery workflows](delivery.md) before treating an enabled form as a ready
cluster.
