output "api_health_url" {
  value = module.api.api_health_url
}

output "api_dns_name" {
  value = module.api.api_dns_name
}

output "alb_dns_name" {
  value = module.api.alb_dns_name
}

output "cluster_name" {
  value = module.api.cluster_name
}

output "service_name" {
  value = module.api.service_name
}

output "target_group_arn" {
  value = module.api.target_group_arn
}

output "task_security_group_id" {
  value = module.api.task_security_group_id
}
