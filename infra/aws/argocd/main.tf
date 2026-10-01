locals {
  cluster_name  = "rizz-eks-staging"
  chart         = jsondecode(file("${path.module}/../../cloud-platform/charts.lock.json")).charts["argo-cd"]
  chart_archive = abspath(coalesce(var.argocd_chart_archive, "${path.module}/.terraform/charts/argo-cd-${local.chart.version}.tgz"))
  chart_digest  = try(filesha256(local.chart_archive), "")
}

data "aws_caller_identity" "operator" {}
data "aws_eks_cluster" "staging" {
  name = local.cluster_name
}

resource "terraform_data" "bootstrap_guard" {
  input = {
    cluster_arn  = data.aws_eks_cluster.staging.arn
    chart_digest = local.chart_digest
  }
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.operator.account_id == var.expected_account_id && !endswith(data.aws_caller_identity.operator.arn, ":root")
      error_message = "Refusing wrong-account or AWS root identity."
    }
    precondition {
      condition     = data.aws_eks_cluster.staging.arn == "arn:aws:eks:us-east-1:${var.expected_account_id}:cluster/${local.cluster_name}" && data.aws_eks_cluster.staging.version == "1.35" && data.aws_eks_cluster.staging.status == "ACTIVE" && try(data.aws_eks_cluster.staging.tags["Project"], "") == "rizz-platform" && try(data.aws_eks_cluster.staging.tags["Environment"], "") == "staging"
      error_message = "Argo bootstrap requires the active, tagged EKS 1.35 staging cluster in the reviewed account and region."
    }
    precondition {
      condition     = local.chart_digest == local.chart.sha256
      error_message = "Missing or altered Argo archive. Run node infra/cloud-platform/fetch-argocd-chart.mjs from the repository, then review the pinned chart."
    }
  }
}

resource "helm_release" "argocd" {
  name             = "argocd"
  namespace        = "argocd"
  create_namespace = true
  chart            = local.chart_archive
  version          = local.chart.version
  # Keep the operator-facing Argo settings with the release that owns them.
  # No repository credential or application secret belongs in Helm values.
  values = [yamlencode({
    global = { image = { tag = "v3.5.3" } }
    configs = {
      cm = {
        "admin.enabled"           = true
        "users.anonymous.enabled" = false
        "accounts.rizz-observer"  = "apiKey"
      }
      rbac = {
        "policy.default" = ""
        "policy.csv" = join("\n", [
          "p, role:rizz-observer, applications, get, rizz-app/rizz-ai-staging, allow",
          "g, rizz-observer, role:rizz-observer",
        ])
      }
    }
    controller = {
      replicas  = 1
      resources = { requests = { cpu = "100m", memory = "256Mi" }, limits = { cpu = "500m", memory = "768Mi" } }
    }
    repoServer = {
      replicas  = 1
      resources = { requests = { cpu = "100m", memory = "128Mi" }, limits = { cpu = "500m", memory = "512Mi" } }
    }
    server = {
      replicas  = 1
      service   = { type = "ClusterIP" }
      ingress   = { enabled = false }
      resources = { requests = { cpu = "50m", memory = "128Mi" }, limits = { cpu = "300m", memory = "256Mi" } }
    }
    redis = {
      resources = { requests = { cpu = "50m", memory = "64Mi" }, limits = { cpu = "200m", memory = "128Mi" } }
    }
    redisSecretInit = {
      resources = { requests = { cpu = "25m", memory = "32Mi" }, limits = { cpu = "200m", memory = "128Mi" } }
    }
    dex = { enabled = false }
    applicationSet = {
      replicas  = 0
      resources = { requests = { cpu = "50m", memory = "64Mi" }, limits = { cpu = "200m", memory = "128Mi" } }
    }
    notifications = { enabled = false }
  })]
  wait          = true
  wait_for_jobs = true
  timeout       = 600
  max_history   = 3

  # Preserve failures for diagnosis and never adopt an unrelated Helm release.
  atomic          = false
  upgrade_install = false
  take_ownership  = false
  force_update    = false
  replace         = false
  depends_on      = [terraform_data.bootstrap_guard]
}

output "release_name" { value = helm_release.argocd.name }
output "namespace" { value = helm_release.argocd.namespace }
output "chart_version" { value = local.chart.version }
