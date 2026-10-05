# Registry module owns the bucket and its private storage configuration.
# Keep the distribution-dependent policy outside it to avoid a module cycle.
module "s3_bucket" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "5.16.1"

  bucket        = var.bucket_name
  force_destroy = true
  tags          = var.tags

  attach_policy                    = false
  attach_public_policy             = true
  block_public_acls                = true
  block_public_policy              = true
  ignore_public_acls               = true
  restrict_public_buckets          = true
  skip_destroy_public_access_block = false
  control_object_ownership         = true
  object_ownership                 = "BucketOwnerEnforced"

  versioning = { enabled = false }
  server_side_encryption_configuration = {
    rule = {
      apply_server_side_encryption_by_default = { sse_algorithm = "AES256" }
    }
  }
  # No website endpoint: private REST origin + OAC, not public S3 hosting.
}

resource "aws_s3_bucket_policy" "cloudfront" {
  bucket = module.s3_bucket.s3_bucket_id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ReadOnlyFromThisCloudFrontDistribution"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${module.s3_bucket.s3_bucket_arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = module.cloudfront.cloudfront_distribution_arn
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [module.s3_bucket.s3_bucket_arn, "${module.s3_bucket.s3_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })

  # Do not open origin reads before successful ACTIVE/FREE subscription creation.
  depends_on = [aws_cloudformation_stack.cloudfront]
}
