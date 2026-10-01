mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:user/test-operator" }
  }
  mock_data "aws_eks_cluster" {
    defaults = {
      arn                   = "arn:aws:eks:us-east-1:000000000000:cluster/rizz-eks-staging"
      endpoint              = "https://eks.example.invalid"
      certificate_authority = [{ data = "dGVzdC1jZXJ0" }]
      version               = "1.35"
      status                = "ACTIVE"
      tags                  = { Project = "rizz-platform", Environment = "staging" }
    }
  }
  mock_data "aws_vpc" {
    defaults = { id = "vpc-00000000000000000" }
  }
}
mock_provider "kubernetes" {
  override_resource {
    target = kubernetes_manifest.default_project
    values = {
      manifest = {
        apiVersion = "argoproj.io/v1alpha1"
        kind       = "AppProject"
        metadata   = { name = "default", namespace = "argocd" }
        spec       = { sourceRepos = [], destinations = [], clusterResourceWhitelist = [], namespaceResourceBlacklist = [{ group = "*", kind = "*" }] }
      }
    }
  }
}
variables {
  aws_profile         = "test-only-profile"
  expected_account_id = "000000000000"
  operator_cidr       = "203.0.113.10/32"
  gitops_read_token   = "fixture-never-used-with-AWS"
}

run "bootstrap_ownership_and_delivery" {
  command = plan
  assert {
    condition     = kubernetes_manifest.app_project.manifest.spec.sourceRepos == ["https://github.com/YASHMAHAKAL/backstage-agent-guard-gitops.git"] && kubernetes_manifest.app_project.manifest.spec.clusterResourceWhitelist == []
    error_message = "The app project must allow only the reviewed private repo and no cluster resources."
  }
  assert {
    condition     = kubernetes_manifest.default_project.manifest.spec.sourceRepos == [] && kubernetes_manifest.default_project.manifest.spec.destinations == [] && kubernetes_manifest.default_project.manifest.spec.namespaceResourceBlacklist[0].kind == "*"
    error_message = "The built-in default project must be closed."
  }
  assert {
    condition     = !contains([for item in kubernetes_manifest.app_project.manifest.spec.namespaceResourceWhitelist : item.kind], "Secret") && !contains([for item in kubernetes_manifest.app_project.manifest.spec.namespaceResourceWhitelist : item.kind], "Role") && !contains([for item in kubernetes_manifest.app_project.manifest.spec.namespaceResourceWhitelist : item.kind], "RoleBinding")
    error_message = "Application GitOps must not manage direct Secrets or Kubernetes RBAC."
  }
  assert {
    condition     = kubernetes_manifest.rizz_app.manifest.spec.source.path == "clusters/eks-staging/apps/rizz-ai" && kubernetes_manifest.rizz_app.manifest.spec.source.targetRevision == "main" && kubernetes_manifest.rizz_app.manifest.spec.syncPolicy.automated.prune == false
    error_message = "The fixed Rizz.AI path must auto-sync after merge without auto-prune."
  }
  assert {
    condition     = kubernetes_manifest.platform_app["external-secrets"].manifest.spec.source.targetRevision == "2.11.0" && kubernetes_manifest.platform_app["aws-load-balancer-controller"].manifest.spec.source.targetRevision == "3.5.0"
    error_message = "Platform controller releases must remain pinned."
  }
  assert {
    condition     = kubernetes_manifest.platform_app["external-secrets"].manifest.spec.source.helm.valuesObject.scopedNamespace == "rizz-staging" && kubernetes_manifest.platform_app["aws-load-balancer-controller"].manifest.spec.source.helm.valuesObject.vpcId == "vpc-00000000000000000" && kubernetes_manifest.platform_app["aws-load-balancer-controller"].manifest.spec.ignoreDifferences[0].jsonPointers == ["/data"]
    error_message = "Controller values must retain namespace/VPC and narrow TLS-difference settings."
  }
  assert {
    condition     = kubernetes_secret_v1.gitops_repository.data_wo_revision == 1 && kubernetes_secret_v1.gitops_repository.metadata[0].labels["argocd.argoproj.io/secret-type"] == "repository"
    error_message = "Argo repository credential must use the write-only field."
  }
  assert {
    condition     = kubernetes_ingress_v1.alb_bootstrap[0].metadata[0].annotations["alb.ingress.kubernetes.io/group.name"] == "rizz-staging-demo" && kubernetes_ingress_v1.alb_bootstrap[0].metadata[0].annotations["alb.ingress.kubernetes.io/inbound-cidrs"] == "203.0.113.10/32" && kubernetes_ingress_v1.alb_bootstrap[0].metadata[0].annotations["alb.ingress.kubernetes.io/listen-ports"] == "[{\"HTTP\":80}]"
    error_message = "ALB bootstrap must be a fixed, operator-only HTTP listener in the reviewed group."
  }
  assert {
    condition = (
      length(tls_self_signed_cert.demo) == 1 &&
      length(aws_acm_certificate.demo) == 1 &&
      length(aws_ssm_parameter.demo_https_target) == 1 &&
      aws_ssm_parameter.demo_https_target[0].name == "/rizz/staging/https-target" &&
      aws_ssm_parameter.demo_https_target[0].type == "String" &&
      aws_ssm_parameter.demo_https_target[0].tier == "Standard" &&
      tls_self_signed_cert.demo[0].validity_period_hours == 48 &&
      tls_self_signed_cert.demo[0].is_ca_certificate == false &&
      aws_acm_certificate.demo[0].tags["ManagedBy"] == "terraform" &&
      aws_ssm_parameter.demo_https_target[0].tags["ManagedBy"] == "terraform" &&
      aws_acm_certificate.demo[0].private_key_wo_version == 1
    )
    error_message = "The temporary certificate and metadata handoff must remain pinned to the bootstrap switch and write-only key."
  }
}

run "retirement_disables_only_bootstrap_ingress" {
  command = plan
  variables { enable_alb_bootstrap = false }
  assert {
    condition     = length(kubernetes_ingress_v1.alb_bootstrap) == 0 && length(tls_self_signed_cert.demo) == 0 && length(aws_acm_certificate.demo) == 0 && length(aws_ssm_parameter.demo_https_target) == 0 && kubernetes_manifest.rizz_app.manifest.spec.source.path == "clusters/eks-staging/apps/rizz-ai"
    error_message = "The retirement switch must remove the Ingress, certificate and metadata while retaining the Argo Application."
  }
}

run "reject_open_operator_cidr" {
  command = plan
  variables { operator_cidr = "0.0.0.0/0" }
  expect_failures = [var.operator_cidr]
}

run "reject_private_operator_cidr" {
  command = plan
  variables { operator_cidr = "10.2.3.4/32" }
  expect_failures = [var.operator_cidr]
}

run "reject_wrong_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "111111111111", arn = "arn:aws:iam::111111111111:user/operator" }
  }
  expect_failures = [terraform_data.target_guard]
}

run "reject_unready_cluster" {
  command = plan
  override_data {
    target = data.aws_eks_cluster.staging
    values = {
      arn                   = "arn:aws:eks:us-east-1:000000000000:cluster/rizz-eks-staging"
      endpoint              = "https://eks.example.invalid"
      certificate_authority = [{ data = "dGVzdC1jZXJ0" }]
      version               = "1.35"
      status                = "CREATING"
      tags                  = { Project = "rizz-platform", Environment = "staging" }
    }
  }
  expect_failures = [terraform_data.target_guard]
}
