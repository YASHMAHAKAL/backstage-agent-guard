# Rizz.AI Phase 2 — local catalog/CI/release foundation

This increment prepares Phase 2; it does not complete real trusted ECR publishing or cloud deployment.

## Added locally

- App-owned `catalog-info.yaml`: Rizz.AI System, frontend and backend Components and inline OpenAPI API. Uses existing `platform-team` for organizational context; creates no new reviewer membership/authorization.
- App TechDocs configuration/runbooks. Rendering/publishing TechDocs must still be tested; a local unpublished file location does not establish remote source availability.
- App build-only CI replaces the auto-apply/`kubectl` workflow. Permissions are read-only; tests, mock integration and HIGH/CRITICAL image vulnerability gates precede any future release publishing. Actions and scanner image are pinned. Seven-day scan artifact retention is not deployable release retention.
- Strict paired-release record validation against independently supplied backend evidence. Rejects wrong workflow/ref/commit, failed checks, unknown fields, mutable images, missing registry images, mixed commits, expired artifacts and altered metadata.
- Authenticated, uncached `GET /api/agent-guard/rizz/releases` and `/rizz-releases` page. No upload, approval or deployment action. Production returns `not_configured` and an empty listing; tests alone use fixtures. No cloud proposal is enabled.

## View the unpublished local catalog

Keep your usual startup command, including `.env`, `.env.delivery.local` and GitHub/GitOps/Kubernetes overlays where appropriate. Append this configuration **last**:

```text
--config ../../app-config.rizz-local.yaml
```

It references the sibling Rizz.AI checkout, not a copied descriptor. It retains all existing base/Kind catalog locations because config arrays replace rather than append. If you add other custom locations later, update this overlay or avoid loading conflicting location arrays. Do not ingest the same entities from GitHub and this local overlay simultaneously.

After restarting Backstage and signing in, visit `/catalog/default/system/rizz-ai`, `/catalog/default/component/rizz-frontend`, `/catalog/default/component/rizz-backend`, `/catalog/default/api/rizz-api`, and `/rizz-releases`. Catalog ingestion is asynchronous; schema validation alone is not confirmation that your running server has ingested them. Navigation should expose the release page through its PageBlueprint.

No Kubernetes cluster annotation or cloud Resource entity is asserted for this application yet: EKS does not exist. Existing Kind labels/targets remain unchanged.

## Still required before Phase 2 exit

Local verification: all eight backend suites passed (66 tests, one existing skipped test), all four frontend suites passed (11 tests), TypeScript and both plugin linters passed. The four catalog descriptors passed the installed Backstage kind validators; the embedded API and workflow parsed successfully. These checks do not confirm running catalog ingestion, a TechDocs render, a successful GitHub Actions run, clean container scans or real release provenance.

The optional actionlint binary download stalled and was stopped; actionlint was not executed. Workflow verification in this increment is YAML parsing plus explicit read-only-permission/action-pin checks, not a GitHub Actions execution. Two stale existing Node.js test assertions were aligned with the current three-file recipe and normalized default replica count; production template behavior was not changed.

Authorize reviewed ECR/OIDC bootstrap; implement and run the branch-restricted publisher, bind actual authenticated artifact provenance to the image pair, set coordinated retention and add the real read-only source adapter. Test real immutable image resolution and record/image deletion/expiry. Then implement the separately governed EKS deployment recipe in Phase 4.

Source changes remain local until explicitly reviewed/published. No AWS provisioning, live Gemini/Jev call, artifact publication or push is part of this increment.
# Later increment: publisher and authenticated adapter

Source publishing workflow/generator and Backstage GitHub/ECR adapter are now implemented **locally**, disabled by default. This historical phase report's "not connected" statements describe the first increment. Real ECR/bootstrap/CI activation and live verification are still pending. See [current publishing handoff](rizz-ai-release-publishing.md); no images, workflow runs or deployments were produced.
