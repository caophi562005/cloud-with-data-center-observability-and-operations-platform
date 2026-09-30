variable "project_name" {
  description = "Lowercase project identifier used in Cognito names and tags."
  type        = string

  validation {
    condition     = trimspace(var.project_name) != "" && can(regex("^[a-z0-9][a-z0-9-]*$", var.project_name))
    error_message = "project_name must be non-empty, lowercase, and match ^[a-z0-9][a-z0-9-]*$ without whitespace; provide a lowercase identifier beginning with an alphanumeric character."
  }
}

variable "environment" {
  description = "Lowercase deployment environment identifier."
  type        = string

  validation {
    condition     = trimspace(var.environment) != "" && can(regex("^[a-z0-9][a-z0-9-]*$", var.environment))
    error_message = "environment must be non-empty, lowercase, and match ^[a-z0-9][a-z0-9-]*$ without whitespace; provide a lowercase identifier beginning with an alphanumeric character."
  }
}

variable "callback_urls" {
  description = "Absolute HTTP(S) OAuth callback URLs owned by the BFF."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "callback_urls must contain at least one absolute HTTP(S) URL."
  }

  validation {
    condition = alltrue([
      for url in var.callback_urls : can(regex("^https?://[^[:space:]]+$", url))
    ])
    error_message = "Each callback_urls value must be an absolute http:// or https:// URL without whitespace."
  }
}

variable "logout_urls" {
  description = "Absolute HTTP(S) OAuth logout URLs."
  type        = list(string)

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "logout_urls must contain at least one absolute HTTP(S) URL."
  }

  validation {
    condition = alltrue([
      for url in var.logout_urls : can(regex("^https?://[^[:space:]]+$", url))
    ])
    error_message = "Each logout_urls value must be an absolute http:// or https:// URL without whitespace."
  }
}

variable "generate_secret" {
  description = "Whether Cognito generates an App Client secret."
  type        = bool
  default     = true
}

variable "enable_user_password_auth" {
  description = "Whether to allow USER_PASSWORD_AUTH for the BFF login endpoint."
  type        = bool
  default     = true
}

variable "create_user_pool_domain" {
  description = "Whether to create the Cognito managed-login domain and OAuth configuration."
  type        = bool
  default     = false
}

variable "cognito_domain_prefix" {
  description = "Unique Cognito prefix for the managed-login domain."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.cognito_domain_prefix == null || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.cognito_domain_prefix))
    error_message = "cognito_domain_prefix must be null or a 1-63 character lowercase value matching ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$."
  }
}

variable "enable_google_identity_provider" {
  description = "Whether to create the Google identity provider."
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
  description = "Google OAuth client secret; stored in Terraform state when enabled."
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
  description = "Additional tags merged into the required Cognito tags."
  type        = map(string)
  default     = {}
}
