data "aws_caller_identity" "current" {}

locals {
  name             = "${var.project_name}-${var.environment}-web-pr"
  account_id       = data.aws_caller_identity.current.account_id
  repository_url   = "https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform.git"
  bucket_name      = var.web_bucket_name
  bucket_arn       = "arn:aws:s3:::${local.bucket_name}"
  distribution_id  = var.web_distribution_id
  distribution_arn = "arn:aws:cloudfront::${local.account_id}:distribution/${local.distribution_id}"
  project_arn      = "arn:aws:codebuild:${var.aws_region}:${local.account_id}:project/${local.name}"
  log_group_name   = "/aws/codebuild/${local.name}"
  log_group_arn    = "arn:aws:logs:${var.aws_region}:${local.account_id}:log-group:${local.log_group_name}"
  buildspec_path   = "apps/web/buildspec.yml"
  approval_policy = {
    requires_comment_approval = "ALL_PULL_REQUESTS"
    approver_roles            = ["GITHUB_ADMIN"]
  }
  tags = merge(var.additional_tags, {
    Project   = var.project_name
    Env       = var.environment
    Layer     = "persistent"
    ManagedBy = "terraform"
    Component = "web-pr-build"
  })

  # Exact project ARN avoids a role/project dependency cycle without widening trust.
  trust_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = local.project_arn }
      }
    }]
  })
  deployment_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "OnlyProjectLogStreams"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.log_group_arn}:*"]
      },
      {
        Sid      = "OnlyRepositoryGitHubAppConnection"
        Effect   = "Allow"
        Action   = ["codeconnections:GetConnection", "codeconnections:GetConnectionToken"]
        Resource = [var.github_connection_arn]
      },
      {
        Sid      = "InspectOnlyWebBucket"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:ListBucket"]
        Resource = [local.bucket_arn]
      },
      {
        Sid      = "UploadOnlyWebAssets"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${local.bucket_arn}/*"]
      },
      {
        Sid      = "InspectAndInvalidateOnlyWebDistribution"
        Effect   = "Allow"
        Action   = ["cloudfront:GetDistribution", "cloudfront:CreateInvalidation"]
        Resource = [local.distribution_arn]
      }
    ]
  })
}

module "build_logs" {
  source  = "terraform-aws-modules/cloudwatch/aws//modules/log-group"
  version = "5.7.2"

  name              = local.log_group_name
  retention_in_days = 14
  tags              = local.tags
}

module "build_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role"
  version = "6.8.2"

  name                           = "${local.name}-build"
  use_name_prefix                = false
  source_trust_policy_documents  = [local.trust_policy]
  create_inline_policy           = true
  source_inline_policy_documents = [local.deployment_policy]
  # No managed policies, OIDC providers, or instance profile are created.
  tags = local.tags
}

module "codebuild" {
  source  = "microsoftexpert/codebuild/aws"
  version = "1.0.0"

  name                   = local.name
  description            = "Approved main-targeting PRs: test/build apps/web and publish the shared private dev site."
  service_role_arn       = module.build_role.arn
  source_version         = "refs/heads/main"
  build_timeout          = var.codebuild_build_timeout_minutes
  queued_timeout         = var.codebuild_queued_timeout_minutes
  concurrent_build_limit = 1
  project_visibility     = "PRIVATE"
  tags                   = local.tags

  artifacts = { type = "NO_ARTIFACTS" }
  environment = {
    type            = "LINUX_CONTAINER"
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    privileged_mode = false
    environment_variable = [
      { name = "WEB_BUCKET", value = local.bucket_name },
      { name = "CLOUDFRONT_DISTRIBUTION_ID", value = local.distribution_id }
    ]
  }
  build_source = {
    type                = "GITHUB"
    location            = local.repository_url
    git_clone_depth     = 1
    report_build_status = true
    insecure_ssl        = false
    buildspec           = local.buildspec_path
    auth = {
      type     = "CODECONNECTIONS"
      resource = var.github_connection_arn
    }
  }
  logs_config = {
    cloudwatch_logs = {
      status      = "ENABLED"
      group_name  = module.build_logs.cloudwatch_log_group_name
      stream_name = "web-pr"
    }
    s3_logs = { status = "DISABLED" }
  }
  # Account-scoped credential/report-group collections remain empty.
  webhooks = {
    pr = {
      build_type = "BUILD"
      # Filters within this sole group are ANDed. No PUSH/MERGED/CLOSED events.
      filter_groups = [{
        filters = [
          {
            type    = "EVENT"
            pattern = "PULL_REQUEST_CREATED,PULL_REQUEST_UPDATED,PULL_REQUEST_REOPENED"
          },
          { type = "BASE_REF", pattern = "^refs/heads/main$" }
        ]
      }]
      # Native policy must remain mandatory, not substituted with buildspec checks.
      pull_request_build_policy = local.approval_policy
    }
  }

  depends_on = [module.build_role]
}
