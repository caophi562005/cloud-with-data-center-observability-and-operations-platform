output "bucket_name" {
  description = "Private Singapore bucket for future React build output."
  value       = module.s3_bucket.s3_bucket_id
}

output "bucket_arn" {
  value = module.s3_bucket.s3_bucket_arn
}

output "distribution_id" {
  value = module.cloudfront.cloudfront_distribution_id
}

output "distribution_arn" {
  value = module.cloudfront.cloudfront_distribution_arn
}

output "https_url" {
  value = "https://${module.cloudfront.cloudfront_distribution_domain_name}"
}

output "subscription_arn" {
  value = aws_cloudformation_stack.cloudfront.outputs["SubscriptionArn"]
}

output "pricing_plan" {
  value = aws_cloudformation_stack.cloudfront.outputs["CurrentPlanTier"]
}

output "pricing_plan_status" {
  value = aws_cloudformation_stack.cloudfront.outputs["FreePlanStatus"]
}

output "cloudfront_stack_name" {
  description = "Subscription-only CloudFormation stack; distribution is Registry-managed."
  value       = aws_cloudformation_stack.cloudfront.name
}
