variable "workspace_id" {
  description = "Identifier of the existing AMP workspace; this module never creates a workspace."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ws-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.workspace_id))
    error_message = "workspace_id must be an AMP ws-UUID identifier."
  }
}

variable "workspace_arn" {
  description = "Exact existing AMP workspace ARN, used to restrict SNS publishing."
  type        = string
  nullable    = false

  validation {
    condition = can(regex("^arn:aws:aps:[a-z0-9-]+:[0-9]{12}:workspace/ws-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.workspace_arn)) ? (
      split(":", var.workspace_arn)[3] == var.region &&
      split("/", var.workspace_arn)[1] == var.workspace_id
    ) : false
    error_message = "workspace_arn must be an aws-partition AMP workspace ARN matching region and workspace_id."
  }
}

variable "region" {
  description = "AWS region shared by the existing AMP workspace and SNS topic."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS region identifier."
  }
}

variable "namespace_name" {
  description = "Name of the single VM alert rule-group namespace."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.namespace_name))
    error_message = "namespace_name must contain 1-64 letters, digits, underscores or hyphens."
  }
}

variable "topic_name" {
  description = "Name of the Standard SNS topic; no subscriber is created."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,256}$", var.topic_name))
    error_message = "topic_name must contain 1-256 letters, digits, underscores or hyphens."
  }
}

variable "tags" {
  description = "Persistent ownership and component tags."
  type        = map(string)
  nullable    = false
}
