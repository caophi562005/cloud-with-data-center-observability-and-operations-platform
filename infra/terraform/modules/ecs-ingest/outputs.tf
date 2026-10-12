output "alb_dns_name" { value = module.alb.dns_name }
output "alb_zone_id" { value = module.alb.zone_id }
output "dns_name" { value = aws_route53_record.ingest.fqdn }
output "cluster_name" { value = module.ingest_cluster.name }
output "service_name" { value = module.ingest_service.name }
output "target_group_arn" { value = module.alb.target_groups["ingest"].arn }
output "task_security_group_id" { value = module.ingest_security_group.security_group_id }
output "url" { value = "${var.certificate_arn == null ? "http" : "https"}://${trimsuffix(aws_route53_record.ingest.fqdn, ".")}" }
output "health_url" { value = "${var.certificate_arn == null ? "http" : "https"}://${trimsuffix(aws_route53_record.ingest.fqdn, ".")}/health" }
output "ready_url" { value = "${var.certificate_arn == null ? "http" : "https"}://${trimsuffix(aws_route53_record.ingest.fqdn, ".")}/ready" }
output "remote_write_url" {
  description = "Null until ACM/HTTPS is configured: agent credentials must not use public HTTP."
  value       = var.certificate_arn == null ? null : "https://${trimsuffix(aws_route53_record.ingest.fqdn, ".")}/api/v1/write"
}
