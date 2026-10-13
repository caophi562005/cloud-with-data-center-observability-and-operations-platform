# Only the temporary endpoint's subscription belongs here. The existing
# Standard topic/AMP workspace remain owned by dev/persistent.
variable "sns_alerts_enabled" {
  description = "Enable the API handler first; default off until schema and compatible image are ready."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.sns_alerts_enabled || var.sns_alerts_topic_arn != null
    error_message = "An enabled handler requires the existing persistent SNS topic ARN."
  }
}

variable "sns_alerts_topic_arn" {
  description = "Actual amp_alerts_sns_topic_arn output from dev/persistent; never a duplicate topic."
  type        = string
  default     = null
  validation {
    condition     = var.sns_alerts_topic_arn == null || can(regex("^arn:aws:sns:${var.region}:${var.allowed_account_id}:[A-Za-z0-9_-]{1,256}$", var.sns_alerts_topic_arn))
    error_message = "Supply a Standard SNS topic in the deployment's account/region."
  }
}

variable "sns_alerts_subscription_enabled" {
  description = "Separate opt-in after the deployed handler is reachable and ready; Terraform waits but does not confirm SNS itself."
  type        = bool
  default     = false
  nullable    = false
  validation {
    condition     = !var.sns_alerts_subscription_enabled || (var.sns_alerts_enabled && var.sns_alerts_topic_arn != null)
    error_message = "Subscription requires the enabled API handler and existing topic."
  }
}

resource "aws_sns_topic_subscription" "alerts_api" {
  count                           = var.sns_alerts_subscription_enabled ? 1 : 0
  topic_arn                       = var.sns_alerts_topic_arn
  protocol                        = "https"
  endpoint                        = "https://${trimsuffix(module.api.api_dns_name, ".")}/api/v1/alerts/sns"
  raw_message_delivery            = false
  endpoint_auto_confirms          = true
  confirmation_timeout_in_minutes = 5
  depends_on                      = [module.api]
}

output "sns_alerts_enabled" {
  value = var.sns_alerts_enabled
}
output "sns_alerts_endpoint" {
  value = var.sns_alerts_enabled ? "https://${trimsuffix(module.api.api_dns_name, ".")}/api/v1/alerts/sns" : null
}
output "sns_alerts_subscription_arn" {
  value = try(aws_sns_topic_subscription.alerts_api[0].arn, null)
}
