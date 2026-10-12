variable "alertmanager_resource_group_name" {
  description = "Existing Azure resource group to reuse without Terraform ownership."
  type        = string
  default     = "opsgrid"
  nullable    = false
}

variable "alertmanager_environment_name" {
  description = "New Standard WorkloadProfiles Environment with only a Consumption profile owned by this module."
  type        = string
  default     = "opsgrid-dev-test-alerts"
  nullable    = false
}

variable "alertmanager_container_app_name" {
  description = "Name of the single DEV/TEST Alertmanager Container App."
  type        = string
  default     = "opsgrid-dev-test-alertmanager"
  nullable    = false
}

variable "alertmanager_basic_auth_username" {
  description = "Basic Auth username for Alertmanager UI/API and later Grafana forwarding."
  type        = string
  default     = "grafana"
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,64}$", var.alertmanager_basic_auth_username))
    error_message = "Use a 1-64 character username containing letters, numbers, dots, underscores or hyphens."
  }
}

variable "alertmanager_basic_auth_password_hash" {
  description = "Required bcrypt password hash from private inputs; never supply plaintext. ACA secrets store this hash in Terraform state and saved plans."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = can(regex("^\\$2[aby]\\$(0[4-9]|[12][0-9]|3[01])\\$[./A-Za-z0-9]{53}$", var.alertmanager_basic_auth_password_hash))
    error_message = "Supply a bcrypt hash with a valid 04-31 cost via private inputs, not a plaintext password."
  }
}
