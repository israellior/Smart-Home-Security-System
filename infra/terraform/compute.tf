# The latest Amazon Linux 2023 for arm64, looked up rather than pinned.
# AL2023 ships the SSM agent, and has docker and the ECR credential
# helper in its own repositories.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile   = aws_iam_instance_profile.api.name

  user_data                   = file("${path.module}/user-data.sh")
  user_data_replace_on_change = true

  # IMDSv2 only. v1 answers any GET, which turns a server-side request
  # forgery bug into stolen instance credentials.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
    encrypted   = true
  }

  # Unlimited is the t4g default and bills for bursting past the CPU
  # baseline. This workload idles; standard caps it instead of billing.
  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = "porchlight-api" }

  lifecycle {
    # A new AMI is published every few weeks. Without this, the next
    # `terraform apply` after one would replace the server - an outage
    # nobody asked for. Pick up a new AMI deliberately, with -replace.
    ignore_changes = [ami]
  }
}

# The address every doorbell's DNS lookup lands on, and the one address
# the Atlas access list allows. It survives the instance being replaced,
# which is the whole reason to have one.
resource "aws_eip" "api" {
  domain = "vpc"
  tags   = { Name = "porchlight-api" }
}

resource "aws_eip_association" "api" {
  instance_id   = aws_instance.api.id
  allocation_id = aws_eip.api.id
}
