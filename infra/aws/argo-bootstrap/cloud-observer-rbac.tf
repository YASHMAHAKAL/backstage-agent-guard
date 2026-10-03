# The staging root maps its dedicated read-only IAM role to this EKS group.
# This root owns the namespace Role and RoleBinding, so the app GitOps path
# cannot grant itself additional Kubernetes access.
resource "kubernetes_role_v1" "cloud_observer" {
  metadata {
    name      = "rizz-cloud-observer"
    namespace = kubernetes_namespace_v1.bootstrap["rizz-staging"].metadata[0].name
  }

  rule {
    api_groups     = ["apps"]
    resources      = ["deployments"]
    resource_names = ["rizz-frontend", "rizz-backend"]
    verbs          = ["get"]
  }
  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "replicasets"]
    verbs      = ["list"]
  }
  rule {
    api_groups = [""]
    resources  = ["pods", "services", "configmaps"]
    verbs      = ["list"]
  }
  rule {
    api_groups     = [""]
    resources      = ["services"]
    resource_names = ["rizz-frontend-service", "rizz-backend-service"]
    verbs          = ["get"]
  }
  # Kubernetes RBAC restricts the Service name but not the proxied URL path.
  rule {
    api_groups     = [""]
    resources      = ["services/proxy"]
    resource_names = ["rizz-backend-service"]
    verbs          = ["get"]
  }
  rule {
    api_groups     = [""]
    resources      = ["configmaps"]
    resource_names = ["rizz-runtime"]
    verbs          = ["get"]
  }
  rule {
    api_groups     = ["networking.k8s.io"]
    resources      = ["ingresses"]
    resource_names = ["rizz-frontend"]
    verbs          = ["get"]
  }
  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["ingresses"]
    verbs      = ["list"]
  }
  rule {
    api_groups     = ["external-secrets.io"]
    resources      = ["secretstores", "externalsecrets"]
    resource_names = ["rizz-runtime"]
    verbs          = ["get"]
  }
  rule {
    api_groups = ["external-secrets.io"]
    resources  = ["secretstores", "externalsecrets"]
    verbs      = ["list"]
  }

  depends_on = [terraform_data.target_guard]
}

resource "kubernetes_role_binding_v1" "cloud_observer" {
  metadata {
    name      = "rizz-cloud-observer"
    namespace = kubernetes_namespace_v1.bootstrap["rizz-staging"].metadata[0].name
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.cloud_observer.metadata[0].name
  }

  subject {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Group"
    name      = "rizz-cloud-observers"
  }

  depends_on = [terraform_data.target_guard]
}

# Argo stores sync, health and compared revision on its Application CR. The
# portal reads only this one object through its existing short-lived EKS auth.
resource "kubernetes_role_v1" "argo_application_observer" {
  metadata {
    name      = "rizz-cloud-argo-observer"
    namespace = "argocd"
  }

  rule {
    api_groups     = ["argoproj.io"]
    resources      = ["applications"]
    resource_names = ["rizz-ai-staging"]
    verbs          = ["get"]
  }

  depends_on = [terraform_data.target_guard]
}

resource "kubernetes_role_binding_v1" "argo_application_observer" {
  metadata {
    name      = "rizz-cloud-argo-observer"
    namespace = "argocd"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role_v1.argo_application_observer.metadata[0].name
  }

  subject {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Group"
    name      = "rizz-cloud-observers"
  }

  depends_on = [terraform_data.target_guard]
}
