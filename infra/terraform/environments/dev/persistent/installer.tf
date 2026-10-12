# ACM and its DNS validation CNAME remain manually managed outside this root.
# Use var.installer_certificate_arn explicitly; do not select the newest certificate.
# Verify ISSUED status and hostname coverage before applying a replacement.

# Match dev/test's existing-zone pattern without taking ownership of the zone.
data "aws_route53_zone" "installer" {
  zone_id = var.installer_hosted_zone_id

  lifecycle {
    postcondition {
      condition     = !self.private_zone && endswith(".${var.installer_dns_name}", ".${trimsuffix(self.name, ".")}")
      error_message = "The installer hostname must belong to the selected existing public Route53 hosted zone."
    }
  }
}

# IPv4 and IPv6 alias records are persistent. ACM validation CNAMEs are untouched.
resource "aws_route53_record" "installer" {
  for_each        = toset(["A", "AAAA"])
  zone_id         = data.aws_route53_zone.installer.zone_id
  name            = var.installer_dns_name
  type            = each.value
  allow_overwrite = false

  alias {
    name                   = module.s3_opsgrid_web.distribution_domain_name
    zone_id                = module.s3_opsgrid_web.distribution_hosted_zone_id
    evaluate_target_health = false # CloudFront aliases cannot enable health evaluation.
  }
}
