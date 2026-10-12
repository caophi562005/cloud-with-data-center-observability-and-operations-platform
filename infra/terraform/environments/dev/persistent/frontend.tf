# Reuse the existing public zone/distribution; ACM and installer ownership stay unchanged.
resource "aws_route53_record" "frontend" {
  for_each        = var.frontend_dns_name == null ? toset([]) : toset(["A", "AAAA"])
  zone_id         = data.aws_route53_zone.installer.zone_id
  name            = var.frontend_dns_name
  type            = each.value
  allow_overwrite = false

  alias {
    name                   = module.s3_opsgrid_web.distribution_domain_name
    zone_id                = module.s3_opsgrid_web.distribution_hosted_zone_id
    evaluate_target_health = false
  }

  lifecycle {
    precondition {
      condition     = var.frontend_dns_name == null ? true : endswith(".${var.frontend_dns_name}", ".${trimsuffix(data.aws_route53_zone.installer.name, ".")}")
      error_message = "The frontend hostname must belong to the selected existing public Route53 zone."
    }
  }
}
