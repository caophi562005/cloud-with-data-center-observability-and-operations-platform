locals {
  name          = var.name
  tags          = var.tags
  backend_ports = toset([var.database_port, var.redis_port])
  # Never use unknown new subnet IDs as for_each keys.
  subnet_ids_by_index = { for index, subnet_id in var.subnet_ids : tostring(index) => subnet_id }
  amp_enabled         = var.amp_workspace_arn != null
  amp_workspace_id    = local.amp_enabled ? split("/", var.amp_workspace_arn)[1] : ""
  # AMP endpoints/modes are nonsecret and owned here. Never inject stale cloud credentials.
  api_secret_names = local.amp_enabled ? setsubtract(var.runtime_secret_names, toset([
    "METRICS_QUERY_URL", "METRICS_QUERY_AUTH_MODE", "METRICS_USERNAME", "METRICS_QUERY_TOKEN"
  ])) : var.runtime_secret_names
}

module "amp_proxy" {
  source = "../ecs-amp-proxy"
  count  = local.amp_enabled ? 1 : 0

  region           = var.region
  image_digest_uri = var.amp_proxy_image_digest_uri
  log_group_name   = aws_cloudwatch_log_group.api.name
}

data "aws_vpc" "selected" {
  id = var.vpc_id
  lifecycle {
    postcondition {
      condition     = self.enable_dns_support && self.enable_dns_hostnames
      error_message = "The selected VPC must retain DNS support."
    }
    postcondition {
      condition     = length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2
      error_message = "The selected public subnets must span at least two availability zones."
    }
  }
}
data "aws_subnet" "selected" {
  for_each = local.subnet_ids_by_index
  id       = each.value
  lifecycle {
    postcondition {
      condition     = self.vpc_id == var.vpc_id && self.map_public_ip_on_launch
      error_message = "Only public subnets of the selected VPC are permitted."
    }
  }
}
# Default subnets can inherit the VPC main route table without explicit associations.
data "aws_route_tables" "explicit" {
  for_each = local.subnet_ids_by_index
  vpc_id   = var.vpc_id
  filter {
    name   = "association.subnet-id"
    values = [each.value]
  }
}
data "aws_route_table" "main" {
  vpc_id = var.vpc_id
  filter {
    name   = "association.main"
    values = ["true"]
  }
}
data "aws_route_table" "public" {
  for_each       = local.subnet_ids_by_index
  route_table_id = length(data.aws_route_tables.explicit[each.key].ids) > 0 ? one(data.aws_route_tables.explicit[each.key].ids) : data.aws_route_table.main.id
  lifecycle {
    postcondition {
      condition     = anytrue([for route in self.routes : route.cidr_block == "0.0.0.0/0" && startswith(coalesce(route.gateway_id, "none"), "igw-")])
      error_message = "Each subnet must have a default route through an Internet Gateway."
    }
  }
}

module "alb_security_group" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "5.3.1"

  name        = "${local.name}-alb"
  description = "Public HTTP/HTTPS from configured CIDRs; API-only outbound"
  vpc_id      = var.vpc_id
  ingress_with_cidr_blocks = [{
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = join(",", sort(tolist(var.allowed_ingress_cidrs)))
    description = "Public HTTP redirects to HTTPS"
    }, {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = join(",", sort(tolist(var.allowed_ingress_cidrs)))
    description = "Public HTTPS API"
  }]
  computed_egress_with_source_security_group_id = [{
    from_port                = 3000
    to_port                  = 3000
    protocol                 = "tcp"
    source_security_group_id = module.api_security_group.security_group_id
    description              = "API targets only"
  }]
  number_of_computed_egress_with_source_security_group_id = 1
  tags                                                    = local.tags
}
module "api_security_group" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "5.3.1"

  name        = "${local.name}-task"
  description = "ALB-only inbound; HTTPS and explicit TLS backend ports outbound"
  vpc_id      = var.vpc_id
  computed_ingress_with_source_security_group_id = [{
    from_port                = 3000
    to_port                  = 3000
    protocol                 = "tcp"
    source_security_group_id = module.alb_security_group.security_group_id
    description              = "ALB only"
  }]
  number_of_computed_ingress_with_source_security_group_id = 1
  egress_with_cidr_blocks = concat([
    { from_port = 443, to_port = 443, protocol = "tcp", cidr_blocks = "0.0.0.0/0", description = "HTTPS: Cognito, SSM, logs, public image" }
    ], [for port in local.backend_ports : {
      from_port   = port
      to_port     = port
      protocol    = "tcp"
      cidr_blocks = "0.0.0.0/0"
      description = "Configured TLS backend endpoint port"
  }])
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 1
  tags              = local.tags
}
module "execution_role" {
  source = "../ecs-execution-role"

  name          = "${local.name}-execution"
  region        = var.region
  account_id    = var.account_id
  log_group_arn = aws_cloudwatch_log_group.api.arn
  parameter_arns = [for name in sort(tolist(local.api_secret_names)) :
    "arn:aws:ssm:${var.region}:${var.account_id}:parameter${var.parameter_path}/${name}"
  ]
  tags = local.tags
}

# Names are nonsecret; ephemeral values must never determine resource addresses.
resource "aws_ssm_parameter" "runtime" {
  for_each         = var.runtime_secret_names
  name             = "${var.parameter_path}/${each.key}"
  description      = "Temporary API runtime parameter; value excluded from plans and state"
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = var.runtime_secret_values[each.key]
  value_wo_version = var.secret_value_version
  tags             = local.tags
}

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "10.5.1"

  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  ip_address_type            = "ipv4"
  vpc_id                     = var.vpc_id
  subnets                    = var.subnet_ids
  create_security_group      = false
  security_groups            = [module.alb_security_group.security_group_id]
  enable_deletion_protection = false
  listeners = {
    http = {
      port     = 80
      protocol = "HTTP"
      redirect = { port = "443", protocol = "HTTPS", status_code = "HTTP_301" }
    }
    https = {
      port            = 443
      protocol        = "HTTPS"
      certificate_arn = var.certificate_arn
      ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
      forward         = { target_group_key = "api" }
    }
  }
  target_groups = {
    api = {
      name_prefix          = "api-"
      protocol             = "HTTP"
      port                 = 3000
      target_type          = "ip"
      create_attachment    = false
      deregistration_delay = 15
      health_check = {
        enabled             = true
        path                = "/api/v1/health"
        port                = "traffic-port"
        protocol            = "HTTP"
        matcher             = "200"
        interval            = 30
        timeout             = 10
        healthy_threshold   = 2
        unhealthy_threshold = 3
      }
    }
  }
  tags       = local.tags
  depends_on = [data.aws_vpc.selected, data.aws_route_table.public]
}

module "api_cluster" {
  source  = "terraform-aws-modules/ecs/aws//modules/cluster"
  version = "7.6.1"

  name                        = local.name
  configuration               = null
  setting                     = [{ name = "containerInsights", value = "disabled" }]
  create_cloudwatch_log_group = false
  create_task_exec_iam_role   = false
  cluster_capacity_providers  = ["FARGATE"]
  default_capacity_provider_strategy = {
    FARGATE = { weight = 1, base = 1 }
  }
  tags = local.tags
}
module "api_service" {
  source  = "terraform-aws-modules/ecs/aws//modules/service"
  version = "7.6.1"

  name        = local.name
  cluster_arn = module.api_cluster.arn
  cpu         = var.cpu
  # Reserve headroom for signing without shrinking the existing application's budget.
  memory        = local.amp_enabled ? (var.memory == 1024 ? 2048 : 1024) : var.memory
  desired_count = 1
  launch_type   = "FARGATE"
  capacity_provider_strategy = {
    on_demand = { capacity_provider = "FARGATE", weight = 1, base = 1 }
  }
  enable_autoscaling                = false
  enable_execute_command            = false
  track_latest                      = false
  skip_destroy                      = false
  wait_for_steady_state             = true
  deployment_circuit_breaker        = { enable = true, rollback = true }
  health_check_grace_period_seconds = 120
  subnet_ids                        = var.subnet_ids
  assign_public_ip                  = true
  create_security_group             = false
  security_group_ids                = [module.api_security_group.security_group_id]
  create_task_exec_iam_role         = false
  create_task_exec_policy           = false
  task_exec_iam_role_arn            = module.execution_role.arn
  tasks_iam_role_policies           = {}
  tasks_iam_role_statements = local.amp_enabled || var.sns_alerts_enabled ? concat(local.amp_enabled ? [{
    sid       = "AMPQuery"
    effect    = "Allow"
    actions   = ["aps:QueryMetrics", "aps:ListRules"]
    resources = [var.amp_workspace_arn]
    }] : [], var.sns_alerts_enabled ? [{
    sid       = "SNSAlertConfirmation"
    effect    = "Allow"
    actions   = ["sns:ConfirmSubscription"]
    resources = [var.sns_alerts_topic_arn]
  }] : []) : null
  runtime_platform = { operating_system_family = "LINUX", cpu_architecture = "X86_64" }
  load_balancer = {
    api = { target_group_arn = module.alb.target_groups["api"].arn, container_name = "api", container_port = 3000 }
  }
  container_definitions = merge({
    api = {
      essential              = true
      image                  = var.image_digest_uri
      readonlyRootFilesystem = true
      linuxParameters        = { initProcessEnabled = true, capabilities = { add = [], drop = ["ALL"] } }
      cpu                    = local.amp_enabled ? var.cpu - 64 : null
      memory                 = local.amp_enabled ? (var.memory == 1024 ? 2048 : 1024) - 128 : null
      memoryReservation      = local.amp_enabled ? 512 : null
      dependsOn              = local.amp_enabled ? [{ containerName = "amp-sigv4", condition = "START" }] : []
      environment = concat(local.amp_enabled ? [
        { name = "METRICS_QUERY_AUTH_MODE", value = "none" },
        { name = "METRICS_QUERY_URL", value = "http://127.0.0.1:8005/workspaces/${local.amp_workspace_id}" },
        ] : [], var.sns_alerts_enabled ? [
        { name = "SNS_ALERTS_ENABLED", value = "true" },
        { name = "SNS_ALERTS_TOPIC_ARN", value = var.sns_alerts_topic_arn },
        { name = "SNS_ALERTS_REGION", value = var.region },
      ] : [{ name = "SNS_ALERTS_ENABLED", value = "false" }])
      dockerLabels   = { "opsgrid.runtime-version" = tostring(var.secret_value_version) }
      mountPoints    = []
      systemControls = []
      volumesFrom    = []
      portMappings   = [{ name = "http", containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
      # Resource ARN references order parameter writes before this task definition, not all IAM data reads.
      secrets                     = [for key in sort(tolist(local.api_secret_names)) : { name = key, valueFrom = aws_ssm_parameter.runtime[key].arn }]
      create_cloudwatch_log_group = false
      enable_cloudwatch_logging   = true
      logConfiguration = {
        logDriver = "awslogs"
        options   = { awslogs-group = aws_cloudwatch_log_group.api.name, awslogs-region = var.region, awslogs-stream-prefix = "api" }
      }
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 60
      }
    }
  }, local.amp_enabled ? { "amp-sigv4" = module.amp_proxy[0].container_definition } : {})
  tags       = local.tags
  depends_on = [module.execution_role]
}

# The hosted zone is persistent and already exists; only this API record is temporary.
data "aws_route53_zone" "api" {
  zone_id = var.hosted_zone_id
  # Keep this optional SDK field non-null while the VPC defers data reads.
  # The provider replaces it with the actual zone type; validate that below.
  private_zone = false

  lifecycle {
    postcondition {
      condition     = !self.private_zone && endswith(".${trimsuffix(var.dns_name, ".")}", ".${trimsuffix(self.name, ".")}")
      error_message = "The API record must belong to the selected existing public hosted zone."
    }
  }
}

resource "aws_route53_record" "api" {
  zone_id         = data.aws_route53_zone.api.zone_id
  name            = var.dns_name
  type            = "A"
  allow_overwrite = false

  alias {
    name                   = module.alb.dns_name
    zone_id                = module.alb.zone_id
    evaluate_target_health = true
  }
}
