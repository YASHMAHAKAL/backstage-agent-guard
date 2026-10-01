locals {
  cluster_name    = "rizz-eks-staging"
  server          = "https://kubernetes.default.svc"
  gitops_repo_url = "https://github.com/YASHMAHAKAL/backstage-agent-guard-gitops.git"
  charts          = jsondecode(file("${path.module}/../../cloud-platform/charts.lock.json")).charts
  controller_values = {
    "aws-load-balancer-controller" = merge(yamldecode(file("${path.module}/../../cloud-platform/values/aws-load-balancer-controller.yaml")), { vpcId = data.aws_vpc.staging.id })
    "external-secrets"             = yamldecode(file("${path.module}/../../cloud-platform/values/external-secrets.yaml"))
  }
  platform_namespaced = [
    for kind in ["ServiceAccount", "Service", "ConfigMap", "Secret"] : { group = "", kind = kind }
  ]
  workload_kinds = [
    for kind in ["Deployment", "StatefulSet"] : { group = "apps", kind = kind }
  ]
  platform_cluster_kinds = [
    { group = "apiextensions.k8s.io", kind = "CustomResourceDefinition" },
    { group = "rbac.authorization.k8s.io", kind = "ClusterRole" },
    { group = "rbac.authorization.k8s.io", kind = "ClusterRoleBinding" },
    { group = "admissionregistration.k8s.io", kind = "MutatingWebhookConfiguration" },
    { group = "admissionregistration.k8s.io", kind = "ValidatingWebhookConfiguration" },
    { group = "networking.k8s.io", kind = "IngressClass" },
    { group = "elbv2.k8s.aws", kind = "IngressClassParams" },
  ]
}

data "aws_caller_identity" "operator" {}
data "aws_eks_cluster" "staging" { name = local.cluster_name }
data "aws_vpc" "staging" {
  filter {
    name   = "tag:Name"
    values = [local.cluster_name]
  }
  filter {
    name   = "tag:Project"
    values = ["rizz-platform"]
  }
  filter {
    name   = "tag:Environment"
    values = ["staging"]
  }
}

resource "terraform_data" "target_guard" {
  input = { cluster_arn = data.aws_eks_cluster.staging.arn, vpc_id = data.aws_vpc.staging.id }
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.operator.account_id == var.expected_account_id && !endswith(data.aws_caller_identity.operator.arn, ":root")
      error_message = "Refusing wrong-account or AWS root identity."
    }
    precondition {
      condition     = data.aws_eks_cluster.staging.arn == "arn:aws:eks:us-east-1:${var.expected_account_id}:cluster/${local.cluster_name}" && data.aws_eks_cluster.staging.version == "1.35" && data.aws_eks_cluster.staging.status == "ACTIVE" && try(data.aws_eks_cluster.staging.tags["Project"], "") == "rizz-platform" && try(data.aws_eks_cluster.staging.tags["Environment"], "") == "staging"
      error_message = "Argo bootstrap requires the active, tagged EKS 1.35 staging cluster in the reviewed account."
    }
    precondition {
      condition     = can(regex("^vpc-[a-f0-9]{17}$", data.aws_vpc.staging.id))
      error_message = "Expected exactly one tagged staging VPC."
    }
  }
}

resource "kubernetes_namespace_v1" "bootstrap" {
  for_each = toset(["external-secrets", "rizz-staging"])
  metadata { name = each.key }
  depends_on = [terraform_data.target_guard]
}

# Argo creates its built-in default AppProject on first startup. Declaratively
# import it before closing it, rather than attempting to create a duplicate.
import {
  to = kubernetes_manifest.default_project
  id = "apiVersion=argoproj.io/v1alpha1,kind=AppProject,namespace=argocd,name=default"
}

resource "kubernetes_manifest" "default_project" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "AppProject"
    metadata   = { name = "default", namespace = "argocd" }
    spec = {
      sourceRepos                = []
      destinations               = []
      clusterResourceWhitelist   = []
      namespaceResourceBlacklist = [{ group = "*", kind = "*" }]
    }
  }
  depends_on = [terraform_data.target_guard]
}

resource "kubernetes_manifest" "platform_project" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "AppProject"
    metadata   = { name = "rizz-platform", namespace = "argocd" }
    spec = {
      sourceRepos = [local.charts["aws-load-balancer-controller"].repo, local.charts["external-secrets"].repo]
      destinations = [
        for namespace in ["kube-system", "external-secrets", "rizz-staging"] : { server = local.server, namespace = namespace }
      ]
      clusterResourceWhitelist = local.platform_cluster_kinds
      namespaceResourceWhitelist = concat(local.platform_namespaced, local.workload_kinds, [
        { group = "rbac.authorization.k8s.io", kind = "Role" },
        { group = "rbac.authorization.k8s.io", kind = "RoleBinding" },
      ])
    }
  }
  depends_on = [kubernetes_namespace_v1.bootstrap, terraform_data.target_guard]
}

resource "kubernetes_manifest" "app_project" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "AppProject"
    metadata   = { name = "rizz-app", namespace = "argocd" }
    spec = {
      sourceRepos              = [local.gitops_repo_url]
      destinations             = [{ server = local.server, namespace = "rizz-staging" }]
      clusterResourceWhitelist = []
      namespaceResourceWhitelist = concat(
        [for item in local.platform_namespaced : item if item.kind != "Secret"],
        local.workload_kinds,
        [
          { group = "networking.k8s.io", kind = "Ingress" },
          { group = "external-secrets.io", kind = "SecretStore" },
          { group = "external-secrets.io", kind = "ExternalSecret" },
        ],
      )
    }
  }
  depends_on = [kubernetes_namespace_v1.bootstrap, terraform_data.target_guard]
}

# The read token is write-only and ephemeral: neither saved plan nor state has
# its value. Supply the same private token to the reviewed plan and its apply.
resource "kubernetes_secret_v1" "gitops_repository" {
  metadata {
    name      = "rizz-gitops-repository"
    namespace = "argocd"
    labels    = { "argocd.argoproj.io/secret-type" = "repository" }
  }
  type = "Opaque"
  data_wo = {
    type     = "git"
    url      = local.gitops_repo_url
    username = "x-access-token"
    password = var.gitops_read_token
  }
  data_wo_revision = var.gitops_credential_revision
  depends_on       = [terraform_data.target_guard]
}

resource "kubernetes_manifest" "platform_app" {
  for_each = toset(["aws-load-balancer-controller", "external-secrets"])
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata   = { name = each.key, namespace = "argocd" }
    spec = merge({
      project = "rizz-platform"
      source = {
        repoURL        = local.charts[each.key].repo
        chart          = each.key
        targetRevision = local.charts[each.key].version
        helm           = { releaseName = each.key, valuesObject = local.controller_values[each.key] }
      }
      destination = {
        server    = local.server
        namespace = each.key == "external-secrets" ? "external-secrets" : "kube-system"
      }
      syncPolicy = {
        automated   = { prune = false, selfHeal = true }
        syncOptions = ["ServerSideApply=true", "RespectIgnoreDifferences=true"]
      }
      }, each.key == "aws-load-balancer-controller" ? {
      ignoreDifferences = concat(
        [{ group = "", kind = "Secret", name = "aws-load-balancer-tls", namespace = "kube-system", jsonPointers = ["/data"] }],
        [for kind in ["MutatingWebhookConfiguration", "ValidatingWebhookConfiguration"] : {
          group = "admissionregistration.k8s.io", kind = kind, name = "aws-load-balancer-webhook", jqPathExpressions = [".webhooks[].clientConfig.caBundle"]
        }],
      )
    } : {})
  }
  wait { fields = { "status.sync.status" = "Synced", "status.health.status" = "Healthy" } }
  timeouts {
    create = "15m"
    update = "15m"
  }
  depends_on = [kubernetes_manifest.platform_project, kubernetes_namespace_v1.bootstrap]
}

# A fixed 503 response creates the operator-restricted ALB before its AWS DNS
# name is known. No Rizz.AI workload is exposed. The application Ingress later
# joins this group on HTTPS only; it remains owned by GitOps.
resource "kubernetes_ingress_v1" "alb_bootstrap" {
  count = var.enable_alb_bootstrap ? 1 : 0
  metadata {
    name      = "rizz-alb-bootstrap"
    namespace = "rizz-staging"
    annotations = {
      "alb.ingress.kubernetes.io/group.name"            = "rizz-staging-demo"
      "alb.ingress.kubernetes.io/load-balancer-name"    = "rizz-staging-demo"
      "alb.ingress.kubernetes.io/scheme"                = "internet-facing"
      "alb.ingress.kubernetes.io/ip-address-type"       = "ipv4"
      "alb.ingress.kubernetes.io/listen-ports"          = "[{\"HTTP\":80}]"
      "alb.ingress.kubernetes.io/inbound-cidrs"         = var.operator_cidr
      "alb.ingress.kubernetes.io/actions.bootstrap-503" = jsonencode({ type = "fixed-response", fixedResponseConfig = { contentType = "text/plain", statusCode = "503", messageBody = "Awaiting approved Rizz.AI release" } })
    }
  }
  spec {
    ingress_class_name = "alb"
    rule {
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend {
            service {
              name = "bootstrap-503"
              port { name = "use-annotation" }
            }
          }
        }
      }
    }
  }
  wait_for_load_balancer = true
  depends_on             = [kubernetes_manifest.platform_app]
}

resource "kubernetes_manifest" "rizz_app" {
  manifest = {
    apiVersion = "argoproj.io/v1alpha1"
    kind       = "Application"
    metadata   = { name = "rizz-ai-staging", namespace = "argocd" }
    spec = {
      project = "rizz-app"
      source = {
        repoURL        = local.gitops_repo_url
        targetRevision = "main"
        path           = "clusters/eks-staging/apps/rizz-ai"
      }
      destination = { server = local.server, namespace = "rizz-staging" }
      syncPolicy = {
        automated   = { prune = false, selfHeal = true }
        syncOptions = ["ServerSideApply=true"]
      }
    }
  }
  # The initial GitOps path may be empty until Backstage's first approved PR.
  # Argo will reconcile it after merge; no Terraform plan is needed for a release.
  depends_on = [kubernetes_manifest.app_project, kubernetes_secret_v1.gitops_repository, kubernetes_ingress_v1.alb_bootstrap]
}

output "app_application_name" { value = kubernetes_manifest.rizz_app.manifest.metadata.name }
output "platform_application_names" { value = sort(keys(kubernetes_manifest.platform_app)) }
output "bootstrap_alb_dns_name" { value = try(kubernetes_ingress_v1.alb_bootstrap[0].status[0].load_balancer[0].ingress[0].hostname, null) }
