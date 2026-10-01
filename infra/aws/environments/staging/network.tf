locals {
  cluster_name = "rizz-eks-staging"
  azs          = { for index, az in var.availability_zones : tostring(index) => az }
}
data "aws_caller_identity" "operator" {}
resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.operator.account_id == var.expected_account_id && !endswith(data.aws_caller_identity.operator.arn, ":root")
      error_message = "Refusing AWS root or wrong-account identity."
    }
  }
}
resource "aws_vpc" "staging" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "rizz-eks-staging" }
  depends_on           = [terraform_data.account_guard]
}
resource "aws_internet_gateway" "staging" { vpc_id = aws_vpc.staging.id }
resource "aws_subnet" "public" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.staging.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, tonumber(each.key) + 101)
  map_public_ip_on_launch = false
  tags                    = { Name = "rizz-public-${each.key}", "kubernetes.io/role/elb" = "1" }
}
resource "aws_subnet" "private" {
  for_each                = local.azs
  vpc_id                  = aws_vpc.staging.id
  availability_zone       = each.value
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, tonumber(each.key) + 1)
  map_public_ip_on_launch = false
  tags                    = { Name = "rizz-private-${each.key}", "kubernetes.io/role/internal-elb" = "1" }
}
resource "aws_route_table" "public" { vpc_id = aws_vpc.staging.id }
resource "aws_route" "internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.staging.id
}
resource "aws_route_table_association" "public" {
  for_each       = local.azs
  subnet_id      = aws_subnet.public[each.key].id
  route_table_id = aws_route_table.public.id
}
resource "aws_eip" "nat" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.staging]
}
resource "aws_nat_gateway" "staging" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public["0"].id
  depends_on    = [aws_route.internet]
}
resource "aws_route_table" "private" { vpc_id = aws_vpc.staging.id }
resource "aws_route" "egress" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.staging.id
}
resource "aws_route_table_association" "private" {
  for_each       = local.azs
  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private.id
}
# Free S3 gateway routing reduces NAT processing for ECR image layer downloads.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.staging.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}
