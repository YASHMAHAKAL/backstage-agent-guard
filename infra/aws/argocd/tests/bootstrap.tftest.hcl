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
}
mock_provider "helm" {}
variables {
  aws_profile         = "test-only-profile"
  expected_account_id = "000000000000"
}

run "private_pinned_installation" {
  command = plan
  assert {
    condition     = helm_release.argocd.name == "argocd" && helm_release.argocd.namespace == "argocd" && helm_release.argocd.create_namespace && helm_release.argocd.version == "10.9.2" && helm_release.argocd.wait && helm_release.argocd.wait_for_jobs
    error_message = "Install the pinned release and wait for workloads and jobs."
  }
  assert {
    condition     = yamldecode(helm_release.argocd.values[0]).server.service.type == "ClusterIP" && !yamldecode(helm_release.argocd.values[0]).server.ingress.enabled && !yamldecode(helm_release.argocd.values[0]).configs.cm["users.anonymous.enabled"] && yamldecode(helm_release.argocd.values[0]).configs.rbac["policy.default"] == ""
    error_message = "Argo must remain private with no anonymous access or default grants."
  }
  assert {
    condition     = !helm_release.argocd.upgrade_install && !helm_release.argocd.take_ownership && !helm_release.argocd.force_update && !helm_release.argocd.replace
    error_message = "Do not adopt or forcibly replace an existing release."
  }
}
run "reject_root_identity" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "000000000000", arn = "arn:aws:iam::000000000000:root" }
  }
  expect_failures = [terraform_data.bootstrap_guard]
}
run "reject_wrong_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.operator
    values = { account_id = "111111111111", arn = "arn:aws:iam::111111111111:user/operator" }
  }
  expect_failures = [terraform_data.bootstrap_guard]
}
run "reject_wrong_cluster" {
  command = plan
  override_data {
    target = data.aws_eks_cluster.staging
    values = {
      arn                   = "arn:aws:eks:us-east-1:000000000000:cluster/other-cluster"
      endpoint              = "https://other.example.invalid"
      certificate_authority = [{ data = "dGVzdC1jZXJ0" }]
      version               = "1.35"
      status                = "ACTIVE"
      tags                  = { Project = "rizz-platform", Environment = "staging" }
    }
  }
  expect_failures = [terraform_data.bootstrap_guard]
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
  expect_failures = [terraform_data.bootstrap_guard]
}
run "reject_altered_archive" {
  command = plan
  variables { argocd_chart_archive = "tests/fixtures/altered-chart.txt" }
  expect_failures = [terraform_data.bootstrap_guard]
}
run "reject_missing_archive" {
  command = plan
  variables { argocd_chart_archive = "tests/fixtures/not-present.tgz" }
  expect_failures = [terraform_data.bootstrap_guard]
}
run "reject_default_profile" {
  command = plan
  variables { aws_profile = "default" }
  expect_failures = [var.aws_profile]
}
