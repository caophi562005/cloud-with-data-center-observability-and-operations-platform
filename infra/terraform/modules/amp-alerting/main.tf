locals {
  workspace_account = try(split(":", var.workspace_arn)[4], "")
}

resource "aws_sns_topic" "alerts" {
  name       = var.topic_name
  fifo_topic = false
  tags       = var.tags

  # No SNS SSE or subscription in this DEV scope; TLS is transport protection,
  # not encryption at rest. The topic is not a notification archive/backlog.
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowAMPWorkspacePublish"
      Effect = "Allow"
      Principal = {
        Service = "aps.amazonaws.com"
      }
      Action   = ["sns:Publish", "sns:GetTopicAttributes"]
      Resource = aws_sns_topic.alerts.arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = var.workspace_arn
        }
        StringEquals = {
          "aws:SourceAccount" = local.workspace_account
        }
      }
    }]
  })
}

resource "aws_prometheus_alert_manager_definition" "this" {
  workspace_id = var.workspace_id
  definition = yamlencode({
    alertmanager_config = templatefile("${path.module}/alertmanager-config.yaml.tftpl", {
      topic_arn = aws_sns_topic.alerts.arn
      region    = var.region
    })
    template_files = {
      opsgrid_sns = file("${path.module}/sns-message.tmpl")
    }
  })

  # Configure delivery permission before enabling the workspace-wide receiver.
  depends_on = [aws_sns_topic_policy.alerts]
}

resource "aws_prometheus_rule_group_namespace" "vm" {
  name         = var.namespace_name
  workspace_id = var.workspace_id
  data         = file("${path.module}/vm-alerts.yaml")
  tags         = var.tags

  # Do not start rules before the receiver configuration exists.
  depends_on = [aws_prometheus_alert_manager_definition.this]
}
