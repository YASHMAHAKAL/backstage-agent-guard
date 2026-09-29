variable "aws_profile" {
  type    = string
  default = "rizz-platform"
}
variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Supply the intended 12-digit account ID privately."
  }
}
variable "github_repository" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use the exact application owner/repository, without wildcards or URLs."
  }
}
variable "github_branch" {
  type    = string
  default = "master"
  validation {
    condition     = contains(["master", "main"], var.github_branch)
    error_message = "Publishing is restricted to the reviewed main/master branch."
  }
}
variable "create_github_oidc_provider" {
  type        = bool
  default     = false
  description = "Set true only after read-only account preflight confirms no shared GitHub OIDC provider exists."
}
variable "github_oidc_subject" {
  type        = string
  description = "Exact verified GitHub branch subject. Supports legacy name subjects and immutable owner/repository IDs; no environment/wildcard subject."
  validation {
    condition = can(regex("^repo:[A-Za-z0-9_.@/-]+:ref:refs/heads/(main|master)$", var.github_oidc_subject)) && replace(
      var.github_oidc_subject, "/@[0-9]+/", ""
    ) == "repo:${var.github_repository}:ref:refs/heads/${var.github_branch}"
    error_message = "Provide the verified exact branch sub claim matching this repo/ref, optionally with numeric immutable owner/repo IDs."
  }
}
variable "existing_github_oidc_provider_arn" {
  type     = string
  default  = null
  nullable = true
  validation {
    condition = var.create_github_oidc_provider ? var.existing_github_oidc_provider_arn == null : can(regex(
      "^arn:aws:iam::${var.expected_account_id}:oidc-provider/token[.]actions[.]githubusercontent[.]com$",
      var.existing_github_oidc_provider_arn
    ))
    error_message = "Choose either explicit provider creation or the existing provider ARN from the intended account; never both."
  }
}
variable "budget_limit_usd" {
  type = number
  validation {
    condition     = var.budget_limit_usd >= 1 && var.budget_limit_usd <= 100 && floor(var.budget_limit_usd) == var.budget_limit_usd
    error_message = "Supply an explicitly agreed whole-dollar demo alert budget between 1 and 100."
  }
}
variable "budget_email" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+[.][^@ ]+$", var.budget_email))
    error_message = "Supply a private alert email; never put it in committed examples."
  }
}
