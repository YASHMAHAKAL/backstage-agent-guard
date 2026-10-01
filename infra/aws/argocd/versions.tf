terraform {
  required_version = ">= 1.15.8, < 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "3.2.0"
    }
  }
  backend "s3" {
    key          = "rizz-platform/argocd-staging/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = "us-east-1"
  profile             = var.aws_profile
  allowed_account_ids = [var.expected_account_id]
}

# Fetch fresh, short-lived EKS credentials. Never load the current kubeconfig or
# use a cached token that can expire between reviewing and applying a plan.
provider "helm" {
  kubernetes = {
    host                   = data.aws_eks_cluster.staging.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.staging.certificate_authority[0].data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["--profile", var.aws_profile, "--region", "us-east-1", "eks", "get-token", "--cluster-name", local.cluster_name]
    }
  }
}
