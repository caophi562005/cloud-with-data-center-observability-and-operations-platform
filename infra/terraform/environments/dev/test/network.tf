# Dedicated temporary dev/test network; no shared/default VPC is adopted.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  create_vpc = true
  name       = var.network_name
  cidr       = var.vpc_cidr
  azs        = var.availability_zones
  public_subnets = [
    cidrsubnet(var.vpc_cidr, 8, 0),
    cidrsubnet(var.vpc_cidr, 8, 1),
  ]
  private_subnets = []

  enable_dns_support      = true
  enable_dns_hostnames    = true
  map_public_ip_on_launch = true
  create_igw              = true
  enable_nat_gateway      = false
  enable_vpn_gateway      = false
  enable_ipv6             = false
  manage_default_vpc      = false

  # Harden only the automatically-created default SG of THIS new VPC.
  # ECS/ALBs use four separate security-group module instances, never this SG.
  manage_default_security_group  = true
  default_security_group_ingress = []
  default_security_group_egress  = []
  manage_default_network_acl     = false
  manage_default_route_table     = false

  tags = {
    Project     = "opsgrid"
    Environment = "dev"
    ManagedBy   = "terraform"
    Component   = "network"
    Lifecycle   = "temporary-test"
  }
}

locals {
  # Known list length / index keys even while the new subnet IDs are unknown.
  public_subnet_ids = [module.vpc.public_subnets[0], module.vpc.public_subnets[1]]
}

output "vpc_id" {
  description = "Dedicated temporary VPC owned by this dev/test state."
  value       = module.vpc.vpc_id
}
output "public_subnet_ids" {
  value = local.public_subnet_ids
}
output "vpc_default_security_group_id" {
  description = "Default SG with no ingress/egress; not attached to services."
  value       = module.vpc.default_security_group_id
}
