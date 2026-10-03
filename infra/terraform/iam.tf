locals {
  param_prefix = "/porchlight/prod"
  log_group    = "/porchlight/prod"
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------
# The instance's own identity: what the server itself may do.
# ---------------------------------------------------------------------

resource "aws_iam_role" "api" {
  name = "porchlight-api-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_instance_profile" "api" {
  name = "porchlight-api-instance"
  role = aws_iam_role.api.name
}

# Session Manager (the replacement for SSH) and Run Command (how deploys
# arrive) both need this.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "api" {
  name = "porchlight-api"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.param_prefix}*"
      },
      {
        # SecureString values are encrypted under the aws/ssm key; this
        # lets them be decrypted only when the request comes through SSM.
        Sid       = "DecryptSecretsViaSsm"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
      },
      {
        Sid      = "PullImages"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.api.arn
      },
      {
        # Account-wide by design: this call has no resource to scope to.
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid      = "FetchReleases"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.releases.arn}/*"
      },
      {
        Sid      = "ShipLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      }
    ]
  })
}

# ---------------------------------------------------------------------
# GitHub Actions: deploys with a token GitHub mints per run, exchanged
# for short-lived AWS credentials. There is no AWS key stored in GitHub,
# so there is none to leak - which matters more than usual on a public
# repository.
# ---------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_owner = split("/", var.github_repository)[0]
  github_name  = split("/", var.github_repository)[1]
  # Exactly what GitHub puts in `sub` - read off a rejected attempt in
  # CloudTrail, where the userName field records the subject presented.
  github_oidc_subject = "repo:${local.github_owner}@${var.github_owner_id}/${local.github_name}@${var.github_repository_id}:environment:production"
}

resource "aws_iam_role" "deploy" {
  name = "porchlight-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Only a job running in this repo's `production` environment.
          # Not a branch pattern: anyone can push a branch to a fork and
          # open a PR, but only this repo's settings decide which
          # branches may use the environment (main, in infra/README.md).
          "token.actions.githubusercontent.com:sub" = local.github_oidc_subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "porchlight-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PushImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"
        ]
        Resource = aws_ecr_repository.api.arn
      },
      {
        Sid      = "UploadRelease"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.releases.arn}/*"
      },
      {
        # Run Command against this one instance, with the one stock
        # document that runs a shell script - and nothing else.
        Sid    = "RunDeploy"
        Effect = "Allow"
        Action = "ssm:SendCommand"
        Resource = [
          aws_instance.api.arn,
          "arn:aws:ssm:${var.region}::document/AWS-RunShellScript"
        ]
      },
      {
        Sid      = "WatchDeploy"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
        Resource = "*"
      }
    ]
  })
}
