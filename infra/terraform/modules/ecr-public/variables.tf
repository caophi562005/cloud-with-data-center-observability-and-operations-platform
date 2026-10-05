variable "repository_name" {
  description = "Long-lived public repository name, independent of temporary branches."
  type        = string
  default     = "opsgrid-ingest"
  nullable    = false

  validation {
    condition     = length(var.repository_name) >= 2 && length(var.repository_name) <= 256 && can(regex("^([a-z0-9]+([._-][a-z0-9]+)*/)*[a-z0-9]+([._-][a-z0-9]+)*$", var.repository_name))
    error_message = "repository_name must be 2-256 characters using lowercase alphanumeric components separated by '.', '_', '-', or '/'."
  }
}

variable "project_name" {
  description = "Project identifier used in repository tags."
  type        = string
  default     = "opsgrid"
  nullable    = false
}

variable "environment" {
  description = "Deployment environment used in repository tags."
  type        = string
  default     = "dev"
  nullable    = false
}

variable "force_destroy" {
  description = "Delete repository images when destroying; opt in only when data loss is approved."
  type        = bool
  default     = false
  nullable    = false
}

variable "additional_tags" {
  description = "Additional tags merged with the required repository tags."
  type        = map(string)
  default     = {}
  nullable    = false
}
