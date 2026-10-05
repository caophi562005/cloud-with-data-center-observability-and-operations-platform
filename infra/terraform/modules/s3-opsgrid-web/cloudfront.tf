resource "aws_wafv2_web_acl" "cloudfront" {
  provider = aws.global
  name     = "${var.site_name}-cloudfront"
  scope    = "CLOUDFRONT"
  tags     = var.tags

  # Required by the real CloudFront flat-rate plan; not a custom WAF ruleset.
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = false
    sampled_requests_enabled   = false
    metric_name                = "${var.site_name}-cloudfront"
  }
}

# This Registry module owns the native distribution, OAC and SPA function.
module "cloudfront" {
  source    = "terraform-aws-modules/cloudfront/aws"
  version   = "6.7.1"
  providers = { aws = aws.global }

  comment             = "${var.site_name} private S3 + FREE plan"
  enabled             = true
  default_root_object = "index.html"
  http_version        = "http2"
  is_ipv6_enabled     = true
  price_class         = "PriceClass_All"
  wait_for_deployment = true
  retain_on_delete    = false
  web_acl_id          = aws_wafv2_web_acl.cloudfront.arn
  tags                = var.tags

  create_monitoring_subscription = false
  create_connection_function     = false
  enable_v2_logging              = false

  origin_access_control = {
    singapore-s3 = {
      name             = "${var.site_name}-oac"
      description      = "Signed access to the private Singapore asset bucket"
      origin_type      = "s3"
      signing_behavior = "always"
      signing_protocol = "sigv4"
    }
  }
  origin = {
    singapore-s3 = {
      domain_name               = module.s3_bucket.s3_bucket_bucket_regional_domain_name
      origin_access_control_key = "singapore-s3"
    }
  }
  cloudfront_functions = {
    spa-rewrite = {
      name    = "${var.site_name}-spa-rewrite"
      runtime = "cloudfront-js-2.0"
      comment = "Rewrite extensionless React routes, not missing static assets"
      code    = file("${path.module}/spa-rewrite.js")
      publish = true
    }
  }
  default_cache_behavior = {
    target_origin_id       = "singapore-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # v6.7.1 suppresses legacy ForwardedValues when cache_policy_id is set.
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    function_association = {
      viewer-request = { function_key = "spa-rewrite" }
    }
  }
  ordered_cache_behavior = [{
    path_pattern           = "/assets/*"
    target_origin_id       = "singapore-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }]
  viewer_certificate = {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1"
  }
}

# AWS6.67.0 and the Registry module have no native pricing subscription resource.
# CloudFormation owns ONLY the real Free subscription over the external ARNs.
resource "aws_cloudformation_stack" "cloudfront" {
  provider      = aws.global
  name          = "${var.site_name}-cloudfront-free"
  template_body = jsonencode(yamldecode(file("${path.module}/cloudfront.yaml")))
  on_failure    = "ROLLBACK"
  parameters = {
    DistributionArn = module.cloudfront.cloudfront_distribution_arn
    WebAclArn       = aws_wafv2_web_acl.cloudfront.arn
  }
  tags = var.tags
  policy_body = jsonencode({
    Statement = [
      { Effect = "Allow", Action = "Update:*", Principal = "*", Resource = "*" },
      { Effect = "Deny", Action = ["Update:Replace", "Update:Delete"], Principal = "*", Resource = "*" }
    ]
  })
  timeouts {
    create = "60m"
    update = "60m"
    delete = "60m"
  }
  lifecycle {
    postcondition {
      condition     = self.outputs["FreePlanStatus"] == "ACTIVE" && self.outputs["CurrentPlanTier"] == "FREE"
      error_message = "The CloudFront FREE subscription must be ACTIVE; this deployment is not verified Free otherwise."
    }
  }
}
