# Rizz.AI — restricted ALB demo without a purchased domain

Decision: Rizz.AI belongs to `group:default/platform-team`. Keep the EKS frontend
behind an internet-facing ALB, but permit HTTPS only from one reviewed operator
public IPv4 `/32`. Backend stays ClusterIP with no direct ingress. Use AWS's ALB
hostname, an imported temporary self-signed certificate and explicit client
certificate verification. No purchased domain, Route 53 zone or Private CA.
Existing distinct-reviewer policy still applies; this does not invent group
membership or grant an agent approval rights.

## Implemented versus planned

`infra/cloud-platform/alb-demo.mjs` is **offline preparation only**. It validates
strict operator config and renders one frontend Ingress fragment. It can generate
two-day RSA-2048 certificates locally in a fresh private temporary directory.
It never invokes AWS, kubectl, Terraform, Git publishing or deployment.

Example config has deliberately fake account/certificate/fingerprint and a
documentation-only IP. Do not apply its output. The fragment is not yet wired
into a cloud proposal, frozen snapshot, Scaffolder template or delivery observer.
The broader governed cloud path is still in progress.

## Offline use

Generate the bootstrap certificate only when preparing an authorized live run:

```sh
node infra/cloud-platform/alb-demo.mjs certificate bootstrap rizz-bootstrap.invalid
```

Output contains file paths and the public certificate SHA-256 fingerprint, not
key contents. Directory permissions are 0700; certificate/key files are 0600.
The private key is unencrypted as required for ACM import: protect the directory,
never commit/upload it as a CI artifact or put it in Terraform input/state.
Generation does not import anything into AWS. Keep it outside the workspace and
remove the exact generated directory after the reviewed import/verification.

Prepare an ignored `infra/cloud-platform/alb-demo.config.local.json` using the
example keys. Set actual account, imported certificate ARN/fingerprint and your
reviewed public IPv4 `/32`; do not fetch or broaden your IP automatically.

```sh
node infra/cloud-platform/alb-demo.mjs render infra/cloud-platform/alb-demo.config.local.json
```

This prints YAML only. No cloud path is enabled by this command. The fixed recipe
uses HTTPS 443 only, TLS 1.2/1.3 policy, IPv4, IP targets, frontend service port 80
and `/healthz` ALB checks. Browser→ALB TLS terminates at the ALB; ALB→frontend is
HTTP within the VPC. This is not end-to-end TLS or a network-policy guarantee.

## Required live bootstrap sequence — not executed yet

AWS assigns the exact ALB hostname after creation, so it cannot be predicted
from the chosen load-balancer name. A self-signed certificate needs that hostname
in its SAN for final verification. Use two explicitly reviewed stages:

1. Complete foundation/release/governance prerequisites and obtain separate AWS
   provisioning authority and a numeric spending limit. Verify actual owner
   membership and operator account/profile. Generate/import the bootstrap
   certificate with the narrowly scoped operator identity, not app CI or the
   read-only release-reader role. Confirm it exists in the expected account and
   region. No TLS key material goes through Terraform or Agent Guard.
2. Review bootstrap Ingress through the explicit platform bootstrap procedure
   (or the future governed flow when it supports this stage). It has only the
   bootstrap Host rule and `/32` HTTPS listener. Let the controller create the
   ALB. **Do not send login credentials, call Gemini or claim delivery verified.**
   This is setup, not a completed application release; health checks may run.
3. Read the actual Ingress load-balancer hostname and verify its account,
   region, name/ARN, SG inbound restrictions and HTTPS-only listener using
   authenticated APIs. A hostname-shaped config string is not this evidence.
4. Generate the final certificate with the exact observed hostname:

   ```sh
   node infra/cloud-platform/alb-demo.mjs certificate ready OBSERVED_ALB_HOSTNAME
   ```

5. Import it as a **new certificate ARN**, verify certificate bytes/fingerprint,
   validity and SAN through authenticated ACM reads. Update operator config to
   `stage: ready`, exact hostname and new ARN/fingerprint. Review a fresh GitOps
   change. Do not silently reimport different bytes into an already approved ARN:
   approval must bind the fingerprint, target and exact output. Execution and
   observation must verify certificate contents as well as ARN.
6. Confirm the listener serves exactly the reviewed certificate and that final
   Ingress Host routing works. Test using the local public certificate as an
   explicit trust anchor, e.g. `curl --cacert CERTIFICATE.pem https://OBSERVED_ALB_HOSTNAME/healthz`.
   Never use `curl -k`, disable TLS validation globally, or blindly bypass a
   browser warning. For browser use, explicitly verify/trust this exact leaf
   certificate in a disposable demo profile where supported; remove trust after
   teardown. Browser trust behavior is client-specific, not automatic.
7. Only then use the protected UI and perform any separately authorized bounded
   live Gemini test. Full delivery still requires both workloads/expected image
   digests, rollout and smoke evidence, not `/healthz` alone.

If the ALB is recreated, its hostname changes: renew the certificate and review
again. If your public IP changes, review the new `/32` instead of opening access.
If the certificate expires, stop the test and renew/review; no HTTP fallback.
This is a temporary demo mechanism, not publicly trusted production HTTPS.

## Teardown and boundaries

ALB provisioning is controller-owned, not also Terraform-owned. Application
Scaffolder must never generate/import certificates or create the cloud
foundation. No shared IngressGroup or custom SG override is rendered: those can
bypass/alter the meaning of `inbound-cidrs`. Verify final Services/IngressClass
have no higher-priority annotation/parameter overrides and inspect the actual
SG rules before testing. Restrict trusted writers of these resources.

On an explicitly authorized teardown, delete the approved Ingress while the
controller is alive; confirm ALB/listener/target-group/SG cleanup before EKS
destruction. Delete only the unused demo ACM certificates after detachment;
remove local trust and exact local key bundles. Do not delete unrelated certs,
the state bucket or retained registry images. Follow `infra/aws/TEARDOWN.md`.

## Verification and official references

Local tests cover strict inputs, `/32` restrictions, frontend-only HTTPS output,
hostname checks and real local OpenSSL certificates/SAN/key pairing/permissions.
They do not test a real ALB, ACM import, SG enforcement or browser trust.

- [Controller annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/): HTTPS listener/certificate/inbound CIDR/IP targets; Service annotations can override Ingress values.
- [ACM import requirements](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate-prerequisites.html): self-signed import, RSA algorithms and protected unencrypted PEM keys.
- [ALB DNS names](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html): AWS-generated hostname.

Reviewed against current documentation on 2026-09-27; controller chart remains
pinned by the existing platform lock. No floating chart upgrade is introduced.
