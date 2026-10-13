module "workspace" {
  source  = "terraform-aws-modules/managed-service-prometheus/aws"
  version = "4.3.1"

  create           = true
  create_workspace = true
  workspace_alias  = var.workspace_alias

  # v4.3.1 creates a log group even with logging_configuration = null.
  # Enable workspace logging explicitly and bound the log retention.
  logging_configuration = {
    create_log_group = true
  }
  cloudwatch_log_group_retention_in_days = 7

  create_resource_policy = false
  create_alert_manager   = false
  rule_group_namespaces  = {}
  limits_per_label_set   = null

  tags = var.tags
}
