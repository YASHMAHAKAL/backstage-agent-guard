# Delivery workflows

## Local Agent Guard demo

```text
Agent or developer proposes a fixed template
  → Agent Guard validates and freezes the rendered files
  → Jev advises; policy checks identity, owner and scope
  → a different owner-group member reviews in Backstage
  → private Scaffolder task opens a GitOps PR
  → human review and merge
  → Argo CD syncs the local Kind cluster
  → read-only observer verifies the merged files and workload
```

Submitting is safe to inspect; approval and GitOps merge are separate decisions.
The shared guest profile cannot satisfy two-person approval. The Kind target
and the Rizz.AI EKS target are never interchangeable.

## First Rizz.AI cloud deployment

1. Platform operators prepare the protected Terraform state bucket and
   registry, then publish a verified frontend/backend image pair through
   Rizz.AI source CI. This does not deploy the app.
2. Separate Terraform roots create EKS/network/secret metadata, install the
   pinned Argo CD Helm release, and register the private GitOps connection,
   Projects, Applications and platform controllers. Terraform also prepares a
   restricted HTTPS demo target. Each root has its own state and reviewed
   changes. The portal may run locally throughout.
3. In **Rizz.AI deployments**, select a verified paired release, state the
   intended staging deployment, and submit a proposal. A different eligible
   app or platform reviewer checks the exact snapshot and approves it.
4. The guarded task opens a **draft** GitOps PR. Repository review and merge
   are separate. Argo CD then applies the app manifests, including its
   `SecretStore` and `ExternalSecret`; External Secrets reads the private AWS
   value. The frontend uses the restricted ALB; the backend remains private.
5. Refresh the portal's read-only delivery observation. Confirm the merged
   revision, Argo sync, both workload images/readiness, and bounded HTTPS/API
   checks. A CI release artifact or PR alone is not deployment evidence.

The September/October 2026 demo exercised this path through a merged GitOps
PR, ready frontend/backend Pods, and the HTTPS sign-in prompt. It did not
record a successful Gemini provider response. The staging infrastructure was
later reported torn down.

## Later changes

| Change                                   | Workflow                                                                                                                                              | Terraform needed?                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| New application code                     | Push to Rizz.AI source → CI publishes a new verified pair → submit release proposal → distinct review → GitOps PR review/merge → Argo sync and verify | No                                                                         |
| Frontend/backend replicas                | Preview a bounded change to existing GitOps manifests → proposal/review/merge → Argo sync                                                             | No, while existing worker capacity is sufficient                           |
| Return to a prior release                | Choose a previously **verified deployment**, preview a paired-image rollback, obtain a new review, merge its draft PR, verify rollout                 | No                                                                         |
| Retire the application                   | Separate reviewed GitOps stages remove public Ingress, then app resources; verify ALB cleanup before foundation teardown                              | Terraform is needed for bootstrap Ingress and later infrastructure removal |
| Change EKS worker capacity or foundation | Platform-owned configuration change and fresh Terraform plan, distinct plan approval, then exact execution and verification                           | Yes                                                                        |

The Terraform runner contract and portal plan-review area are present, but
the runner is not activated as an autonomous cloud executor. Manual operator
Terraform actions from the demo are distinct from routine app releases.
