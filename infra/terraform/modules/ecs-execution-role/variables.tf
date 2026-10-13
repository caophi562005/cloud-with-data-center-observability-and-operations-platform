variable "name" {
  description = "Exact ECS execution role name; no generated suffix."
  type        = string
  nullable    = false
}

variable "region" {
  description = "Region allowed in the ECS source ARN."
  type        = string
  nullable    = false
}

variable "account_id" {
  description = "Account allowed to assume the role through ECS."
  type        = string
  nullable    = false
}

variable "log_group_arn" {
  description = "Exact CloudWatch log group ARN, without the trailing :*."
  type        = string
  nullable    = false
}

variable "parameter_arns" {
  description = "Exact SSM parameter ARNs injected into this task; no path wildcards."
  type        = set(string)
  nullable    = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
