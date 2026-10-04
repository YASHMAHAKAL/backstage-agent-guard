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
release browser and cloud proposal target are opt-in overlays:

| Command                                                     | Adds                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal`          | Rizz.AI Catalog and Control Center                                                  |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:kind`     | Read-only local Kind Kubernetes view                                                |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:releases` | Read-only verified release browser; needs ignored release config                    |
| `node .yarn/releases/yarn-4.13.0.cjs start:portal:cloud`    | Cloud proposal and observation target; needs both ignored release and cloud configs |

These commands start the **local portal**. They do not provision EKS or
deploy Rizz.AI. The cloud page at `/rizz-deployments` proposes a verified
frontend/backend pair and bounded lifecycle changes only when its private
target, identity and release inputs are configured. See
[Delivery workflows](delivery.md) before treating an enabled form as a ready
cluster.
