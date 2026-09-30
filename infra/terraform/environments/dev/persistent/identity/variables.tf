variable "project_name" {
  description = "Project name used in AWS resource names."
  type        = string
  default     = "opsgrid"

  validation {
    condition     = trimspace(var.project_name) != "" && can(regex("^[a-z0-9][a-z0-9-]*$", var.project_name))
    error_message = "project_name must be non-empty, lowercase, and match ^[a-z0-9][a-z0-9-]*$ without whitespace; provide a lowercase identifier beginning with an alphanumeric character."
  }
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  default     = "dev"

  validation {
    condition     = trimspace(var.environment) != "" && can(regex("^[a-z0-9][a-z0-9-]*$", var.environment))
    error_message = "environment must be non-empty, lowercase, and match ^[a-z0-9][a-z0-9-]*$ without whitespace; provide a lowercase identifier beginning with an alphanumeric character."
  }
}

variable "aws_region" {
  description = "AWS region for the identity resources."
  type        = string

  validation {
    condition     = trimspace(var.aws_region) != ""
    error_message = "aws_region must be non-empty; provide an AWS region such as us-east-1."
  }
}

variable "callback_urls" {
  description = "NestJS BFF OAuth callback URLs."
  type        = list(string)
  default     = ["http://localhost:3000/auth/callback"]

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "callback_urls must contain at least one absolute HTTP(S) URL."
  }

  validation {
    condition = alltrue([
      for url in var.callback_urls : can(regex("^(https://[^[:space:]/?#]+([/?][^[:space:]#]*)?|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?([/?][^[:space:]#]*)?)$", url))
    ])
    error_message = "Each callback_urls value must use https:// for non-local hosts or http:// only for localhost, 127.0.0.1, or [::1], with no whitespace or URL fragment."
  }
}

variable "logout_urls" {
  description = "Post-logout redirect URLs."
  type        = list(string)
  default     = ["http://localhost:5173/login"]

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "logout_urls must contain at least one absolute HTTP(S) URL."
  }

  validation {
    condition = alltrue([
      for url in var.logout_urls : can(regex("^(https://[^[:space:]/?#]+([/?][^[:space:]#]*)?|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?([/?][^[:space:]#]*)?)$", url))
    ])
    error_message = "Each logout_urls value must use https:// for non-local hosts or http:// only for localhost, 127.0.0.1, or [::1], with no whitespace or URL fragment."
  }
}

variable "create_user_pool_domain" {
  description = "Enable Cognito managed login and OAuth endpoints."
  type        = bool
  default     = false
}

variable "cognito_domain_prefix" {
  description = "Unique Cognito domain prefix when managed login is enabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.cognito_domain_prefix == null || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.cognito_domain_prefix))
    error_message = "cognito_domain_prefix must be null or a 1-63 character lowercase value matching ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$."
  }
}

variable "enable_google_identity_provider" {
  description = "Enable the Google identity provider."
  type        = bool
  default     = false
}

variable "google_client_id" {
  description = "Google OAuth client id."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.google_client_id == null || trimspace(var.google_client_id) != ""
    error_message = "google_client_id must be null or non-empty; provide the Google OAuth client id when Google sign-in is enabled."
  }
}

variable "google_client_secret" {
  description = "Google OAuth client secret; never commit this value."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true

  validation {
    condition     = var.google_client_secret == null || trimspace(var.google_client_secret) != ""
    error_message = "google_client_secret must be null or non-empty; provide the Google OAuth client secret when Google sign-in is enabled."
  }
}

variable "additional_tags" {
  description = "Additional AWS tags."
  type        = map(string)
  default     = {}
}
