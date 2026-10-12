module "amp_alerting" {
  source = "../../../modules/amp-alerting"

  workspace_id   = module.amp.workspace_id
  workspace_arn  = module.amp.workspace_arn
  region         = var.aws_region
  namespace_name = "${var.project_name}-${var.environment}-vm-alerts"
  topic_name     = "${var.project_name}-${var.environment}-amp-alerts"
  tags = merge(local.tags, {
    Component = "alerting"
    Name      = "${var.project_name}-${var.environment}-amp-alerts"
  })
}
