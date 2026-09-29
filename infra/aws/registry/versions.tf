terraform {
  required_version = ">= 1.15.8, < 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }
  backend "s3" {
    key          = "rizz-platform/registry/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = "us-east-1"
  profile             = var.aws_profile
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = { Project = "rizz-platform", Environment = "staging", ManagedBy = "terraform" }
  }
}
