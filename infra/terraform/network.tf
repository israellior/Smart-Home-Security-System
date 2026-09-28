# A VPC of our own rather than the account's default one, so everything
# the server depends on is declared here and a `terraform destroy` leaves
# nothing behind.
#
# One public subnet and no private ones. A private subnet would need a
# NAT gateway to reach Atlas, R2 and LiveKit - about $32/month, more than
# the server - to protect an instance that already accepts nothing but
# 80 and 443. When this becomes ECS behind a load balancer, that is the
# point to add private subnets.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "porchlight-prod" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "porchlight-prod" }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "porchlight-prod-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "porchlight-prod-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# No port 22. Shell access is SSM Session Manager, which goes out over
# the agent's own HTTPS connection - nothing listens for it, there are no
# SSH keys to leak, and every session is logged against an IAM identity.
resource "aws_security_group" "api" {
  name        = "porchlight-api"
  description = "HTTPS in (Caddy), everything out"
  vpc_id      = aws_vpc.main.id
}

# 80 stays open for two reasons: Let's Encrypt's HTTP-01 challenge, and
# Caddy redirecting anyone who typed http:// to https://.
resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# HTTP/3. Caddy serves it by default; without this rule clients just
# fall back to TCP, so it is an optimisation, not a dependency.
resource "aws_vpc_security_group_ingress_rule" "https_quic" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "udp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
