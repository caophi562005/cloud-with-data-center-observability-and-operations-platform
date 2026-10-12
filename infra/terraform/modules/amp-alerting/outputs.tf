output "sns_topic_arn" {
  description = "ARN of the Standard SNS alert topic; no subscriber is configured."
  value       = aws_sns_topic.alerts.arn
}

output "rule_namespace_name" {
  description = "Name of the VM alert rule-group namespace in the existing workspace."
  value       = aws_prometheus_rule_group_namespace.vm.name
}

output "alert_manager_workspace_id" {
  description = "Existing workspace identifier hosting the Managed Alertmanager definition."
  value       = aws_prometheus_alert_manager_definition.this.workspace_id
}
