terraform {
  required_version = ">= 1.15.8, < 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "2.38.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "4.4.1"
    }
  }
  backend "s3" {
    key          = "rizz-platform/argo-bootstrap-staging/terraform.tfstate"
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

provider "kubernetes" {
  host                   = data.aws_eks_cluster.staging.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.staging.certificate_authority[0].data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["--profile", var.aws_profile, "--region", "us-east-1", "eks", "get-token", "--cluster-name", local.cluster_name]
  }
}
