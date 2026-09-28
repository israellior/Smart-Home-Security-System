# ---------------------------------------------------------------------
# Container images
# ---------------------------------------------------------------------

resource "aws_ecr_repository" "api" {
  name = "porchlight-api"

  # Tags are commit SHAs, and a SHA must always mean the same image -
  # that is what makes "roll back to the previous release" trustworthy.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Storage is billed per GB-month; old releases are only worth keeping as
# rollback targets, and twenty is far more than that needs.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------
# Release bundles: infra/server/ (compose file, Caddyfile, deploy.sh) as
# a tarball per commit. The instance fetches its own bundle by SHA, so
# what runs is exactly what the commit says, and nothing on the server
# is edited by hand.
# ---------------------------------------------------------------------

resource "aws_s3_bucket" "releases" {
  # Bucket names are global across every AWS account; the account ID
  # makes this one ours.
  bucket = "porchlight-releases-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket                  = aws_s3_bucket.releases.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id
  rule {
    id     = "expire-old-releases"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

# ---------------------------------------------------------------------
# Logs. The containers write here through Docker's awslogs driver, so a
# replaced instance does not take its history with it.
# ---------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "app" {
  name              = local.log_group
  retention_in_days = 30
}
