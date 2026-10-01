locals {
  demo_metadata_parameter = "/rizz/staging/https-target"
}

# The Kubernetes provider waits for the controller's observed hostname. This
# lookup then checks the actual ALB before issuing a certificate for that name.
data "aws_lb" "demo" {
  count      = var.enable_alb_bootstrap ? 1 : 0
  name       = "rizz-staging-demo"
  depends_on = [kubernetes_ingress_v1.alb_bootstrap]
}

resource "terraform_data" "demo_alb_guard" {
  count = var.enable_alb_bootstrap ? 1 : 0
  input = data.aws_lb.demo[0].arn
  lifecycle {
    precondition {
      condition = (
        data.aws_lb.demo[0].dns_name == kubernetes_ingress_v1.alb_bootstrap[0].status[0].load_balancer[0].ingress[0].hostname &&
        data.aws_lb.demo[0].vpc_id == data.aws_vpc.staging.id &&
        data.aws_lb.demo[0].load_balancer_type == "application" &&
        data.aws_lb.demo[0].internal == false &&
        try(data.aws_lb.demo[0].tags["elbv2.k8s.aws/cluster"], "") == local.cluster_name &&
        try(data.aws_lb.demo[0].tags["ingress.k8s.aws/stack"], "") == "rizz-staging-demo" &&
        can(regex("^[a-z0-9-]+\\.(?:us-east-1\\.elb|elb\\.us-east-1)\\.amazonaws\\.com$", data.aws_lb.demo[0].dns_name))
      )
      error_message = "The observed bootstrap hostname must belong to the intended public staging ALB."
    }
  }
}

# Both key consumers are write-only. The private key is generated at apply and
# never enters the saved plan, state, SSM parameter, GitOps or Backstage config.
ephemeral "tls_private_key" "demo" {
  count     = var.enable_alb_bootstrap ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "demo" {
  count                      = var.enable_alb_bootstrap ? 1 : 0
  private_key_pem_wo         = ephemeral.tls_private_key.demo[0].private_key_pem
  private_key_pem_wo_version = var.demo_certificate_revision
  subject { common_name = "Rizz.AI temporary demo" }
  dns_names             = [data.aws_lb.demo[0].dns_name]
  validity_period_hours = 48
  early_renewal_hours   = 0
  is_ca_certificate     = false
  allowed_uses          = ["digital_signature", "key_encipherment", "server_auth"]
  depends_on            = [terraform_data.demo_alb_guard]
}

resource "aws_acm_certificate" "demo" {
  count                  = var.enable_alb_bootstrap ? 1 : 0
  private_key_wo         = ephemeral.tls_private_key.demo[0].private_key_pem
  private_key_wo_version = var.demo_certificate_revision
  certificate_body       = tls_self_signed_cert.demo[0].cert_pem
  tags = {
    Project     = "rizz-platform"
    Environment = "staging"
    ManagedBy   = "terraform"
    Purpose     = "temporary-demo-alb"
  }
}

# Public metadata only. The cloud reader independently verifies ACM and ALB.
resource "aws_ssm_parameter" "demo_https_target" {
  count = var.enable_alb_bootstrap ? 1 : 0
  name  = local.demo_metadata_parameter
  type  = "String"
  tier  = "Standard"
  value = jsonencode({
    schemaVersion  = 1
    accountId      = var.expected_account_id
    clusterName    = local.cluster_name
    hostname       = data.aws_lb.demo[0].dns_name
    certificateArn = aws_acm_certificate.demo[0].arn
    operatorCidr   = var.operator_cidr
  })
  tags = {
    Project     = "rizz-platform"
    Environment = "staging"
    ManagedBy   = "terraform"
  }
}

output "demo_https_parameter_name" {
  value = var.enable_alb_bootstrap ? aws_ssm_parameter.demo_https_target[0].name : null
}
