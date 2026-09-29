# Cloud GitOps manifest gate (installation pending)

This is an offline installation bundle, not an installed GitHub check. It uses
the exact Backstage cloud recipe validator, not a permissive second YAML policy.
It validates the entire nine-file app directory at the candidate merge commit:
digest-only paired ECR images, one/two replicas, limits/probes/hardening, private
backend, bounded Gemini configuration, secret references and exact restricted
HTTPS ingress. Extra files, symlinks, changed namespaces/runtime and unrelated
paths in a cloud release PR fail. JSON-as-YAML is deliberate; arbitrary YAML is
not a supported migration path. Non-cloud PRs produce `not_applicable`.

The same bundled validator also permits two narrow retirement transitions:
the exact nine-file recipe to the eight-file ingress-removed recipe, and that
recipe to one empty `kustomization.yaml` marker. It rejects skipping a stage,
reintroducing the app from the retirement marker, unrelated paths, or changes
to other app files during ingress removal. This offline check does not verify
that the controller removed the ALB or that Agent Guard approved a particular
PR; the backend separately checks those conditions for its governed path.

## Operator installation (separate authorization required)

1. In the platform checkout run `node infra/cloud-gitops/build.mjs`. The ignored
   `dist/validate.cjs` bundle needs only Node 22 at runtime; no PR-controlled
   package installation, build scripts, dependencies or credentials.
2. In a reviewed **platform setup PR** to the GitOps repo, install that bundle as
   `.platform/rizz/validate.cjs`, a private operator-filled `target.json` beside
   it matching the backend cloud target, and `rizz-policy.workflow.yaml` as
   `.github/workflows/rizz-policy.yml`. No API tokens, PEM, private keys or
   secret values belong in any of these files. Account/CIDR/hostname/certificate
   ARN are operator metadata: do not publish them in a public portfolio repo.
3. Merge setup first. The workflow intentionally reads policy and target from
   the trusted **base** commit, never the app PR. Review policy upgrades
   separately; a PR changing cloud files and platform policy together fails.
4. Require `rizz-manifest-policy`, current-base checks, human review and dismissal
   of stale approvals before main merges. Protect workflow/policy/target changes
   with platform CODEOWNERS and restricted bypass rights. Where supported, use
   a ruleset-required trusted workflow; an ordinary required job name alone is
   not proof that its workflow was not replaced. Check repository plan support:
   personal private repos on GitHub Free may not offer branch protection.
5. Keep cloud PRs draft until the reviewer compares their diff against the
   frozen files and follows the proposal/approval-digest link in the PR body.

This gate proves **recipe conformance**, not Backstage authorization, paired
build provenance, ECR existence, or deployment. PR text/digest is not a signed
approval receipt. The private publisher and exact snapshot checks provide the
normal portal approval path; protected GitOps writers remain a trust boundary.
Do not claim that every Git change is portal-approved. A future independently
authenticated approval-receipt check/admission gate would strengthen that claim.

Local invocation after build:

```sh
node infra/cloud-gitops/dist/validate.cjs /path/to/gitops \
  /path/to/operator-owned/target.json FULL_BASE_SHA FULL_CANDIDATE_SHA
```

Nothing here changes branch settings, pushes files or creates AWS resources.
Rebuild/review the bundle whenever the platform recipe changes; a stale trusted
bundle must fail, not silently accept new rendering.

Sources: [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
and [required status checks](https://docs.github.com/en/enterprise-cloud%40latest/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
