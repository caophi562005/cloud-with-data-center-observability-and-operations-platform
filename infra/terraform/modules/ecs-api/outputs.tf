output "alb_dns_name" {
  value = module.alb.dns_name
}
output "alb_zone_id" {
  value = module.alb.zone_id
}
output "api_health_url" {
  value = "https://${trimsuffix(aws_route53_record.api.fqdn, ".")}/api/v1/health"
}
output "api_dns_name" {
  value = aws_route53_record.api.fqdn
}
output "cluster_name" {
  value = module.api_cluster.name
}
output "service_name" {
  value = module.api_service.name
}
output "target_group_arn" {
  value = module.alb.target_groups["api"].arn
}
output "task_security_group_id" {
  value = module.api_security_group.security_group_id
}
