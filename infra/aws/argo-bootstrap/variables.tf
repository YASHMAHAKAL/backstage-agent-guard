variable "aws_profile" {
  type    = string
  default = "rizz-platform"
  validation {
    condition     = length(trimspace(var.aws_profile)) > 0 && var.aws_profile != "default"
    error_message = "Use a named reviewed AWS profile, never implicit/default credentials."
  }
}

variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Supply the intended account privately."
  }
}

variable "operator_cidr" {
  description = "The reviewed single public IPv4 address allowed to reach the temporary fixed-response ALB bootstrap listener."
  type        = string
  validation {
    condition = try(
      can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/32$", var.operator_cidr)) &&
      can(cidrhost(var.operator_cidr, 0)) &&
      tonumber(split(".", var.operator_cidr)[0]) >= 1 &&
      tonumber(split(".", var.operator_cidr)[0]) <= 223 &&
      !contains([10, 127], tonumber(split(".", var.operator_cidr)[0])) &&
      !(tonumber(split(".", var.operator_cidr)[0]) == 169 && tonumber(split(".", var.operator_cidr)[1]) == 254) &&
      !(tonumber(split(".", var.operator_cidr)[0]) == 172 && tonumber(split(".", var.operator_cidr)[1]) >= 16 && tonumber(split(".", var.operator_cidr)[1]) <= 31) &&
      !(tonumber(split(".", var.operator_cidr)[0]) == 192 && tonumber(split(".", var.operator_cidr)[1]) == 168),
      false,
    )
    error_message = "Use the reviewed operator IPv4 /32, never an open CIDR."
  }
}

variable "enable_alb_bootstrap" {
  description = "Keep the fixed-response ALB Ingress for initial release. Set false in a separately reviewed retirement plan after the app Ingress is removed."
  type        = bool
  default     = true
}

variable "demo_certificate_revision" {
  description = "Reviewed version of the temporary demo certificate. Increment only in a separately reviewed replacement plan."
  type        = number
  default     = 1
  validation {
    condition     = var.demo_certificate_revision >= 1 && floor(var.demo_certificate_revision) == var.demo_certificate_revision
    error_message = "Certificate revision must be a positive integer."
  }
}

variable "gitops_read_token" {
  description = "Read-only fine-grained token for the one private GitOps repository. Supply as TF_VAR_gitops_read_token at plan and apply; never in a tfvars file."
  type        = string
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = length(var.gitops_read_token) > 0
    error_message = "A private read-only GitOps token is required."
  }
}

variable "gitops_credential_revision" {
  description = "Increment to rotate the write-only repository credential after replacing the private token."
  type        = number
  default     = 1
  validation {
    condition     = var.gitops_credential_revision >= 1 && floor(var.gitops_credential_revision) == var.gitops_credential_revision
    error_message = "Credential revision must be a positive integer."
  }
}
