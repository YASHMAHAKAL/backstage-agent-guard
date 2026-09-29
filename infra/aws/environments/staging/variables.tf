variable "aws_profile" {
  type    = string
  default = "rizz-platform"
}
variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Supply the intended account privately."
  }
}
variable "operator_principal_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:iam::${var.expected_account_id}:(user|role)/[A-Za-z0-9_+=,.@/-]+$", var.operator_principal_arn))
    error_message = "Use an explicitly reviewed IAM user/role in the target account, never root or an STS session ARN."
  }
}
variable "operator_public_cidrs" {
  type = list(string)
  validation {
    condition     = length(var.operator_public_cidrs) >= 1 && length(var.operator_public_cidrs) <= 3 && alltrue([for cidr in var.operator_public_cidrs : can(cidrhost(cidr, 0)) && can(regex("^[0-9.]+/32$", cidr))])
    error_message = "API access requires 1–3 reviewed individual IPv4 /32 operator addresses; never 0.0.0.0/0."
  }
}
variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2 && alltrue([for az in var.availability_zones : can(regex("^us-east-1[a-z]$", az))])
    error_message = "Supply two distinct verified available us-east-1 AZs."
  }
}
variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 8, 103)) && can(regex("^10[.][0-9]+[.]0[.]0/16$", var.vpc_cidr))
    error_message = "Use a reviewed non-overlapping private 10.x.0.0/16 network."
  }
}
variable "node_ami_release_version" {
  description = "Exact AL2023 EKS 1.35 AMI release verified in us-east-1 before plan."
  type        = string
  validation {
    condition     = can(regex("^1[.]35[.][0-9]+-[0-9]{8}$", var.node_ami_release_version))
    error_message = "Pin an explicitly verified EKS 1.35 AL2023 release, not latest or another Kubernetes version."
  }
}
variable "worker_desired_size" {
  description = "Reviewed staging managed-node count. Increase only after checking actual controller/app requests, rollout headroom and demo cost."
  type        = number
  default     = 1
  validation {
    condition     = contains([1, 2], var.worker_desired_size)
    error_message = "Staging worker count must be exactly one or two."
  }
}
variable "addon_versions" {
  description = "Exact compatible versions verified with EKS describe-addon-versions immediately before plan; no latest/default lookup."
  type        = object({ vpc_cni = string, kube_proxy = string, coredns = string, pod_identity_agent = string })
  validation {
    condition     = alltrue([for version in values(var.addon_versions) : can(regex("^v[0-9]+[.][0-9]+[.][0-9]+-eksbuild[.][0-9]+$", version))])
    error_message = "All four add-ons need exact vX.Y.Z-eksbuild.N pins; compatibility is separately verified against EKS 1.35."
  }
}
