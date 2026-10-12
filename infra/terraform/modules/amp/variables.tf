variable "workspace_alias" {
  description = "Alias for the Amazon Managed Service for Prometheus workspace."
  type        = string
  nullable    = false
}

variable "tags" {
  description = "Tags applied to the AMP workspace and its logging group."
  type        = map(string)
  default     = {}
  nullable    = false
}
