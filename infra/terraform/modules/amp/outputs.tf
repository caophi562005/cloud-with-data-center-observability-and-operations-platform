output "workspace_id" {
  description = "Identifier of the AMP workspace."
  value       = module.workspace.workspace_id
}

output "workspace_arn" {
  description = "Amazon Resource Name of the AMP workspace."
  value       = module.workspace.workspace_arn
}

output "endpoint" {
  description = "Base Prometheus endpoint for the AMP workspace; requests require AWS SigV4."
  value       = module.workspace.workspace_prometheus_endpoint
}

output "query_url" {
  description = "Base Prometheus query URL without a trailing slash; clients append API paths and sign requests with AWS SigV4."
  value       = trimsuffix(module.workspace.workspace_prometheus_endpoint, "/")
}

output "remote_write_url" {
  description = "Prometheus remote-write API URL; requests require AWS SigV4."
  value       = "${trimsuffix(module.workspace.workspace_prometheus_endpoint, "/")}/api/v1/remote_write"
}
