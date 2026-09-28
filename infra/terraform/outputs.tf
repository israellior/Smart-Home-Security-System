# Everything GitHub Actions needs, and the one address Atlas must allow.
# None of these are secrets - they go in the `production` environment's
# *variables*, not its secrets. See infra/README.md.

output "public_ip" {
  description = "Add this to the production Atlas project's IP access list."
  value       = aws_eip.api.public_ip
}

output "api_url" {
  value = "https://${local.api_host}"
}

output "github_variables" {
  description = "Set each of these as a variable on the repo's `production` environment."
  value = {
    AWS_REGION      = var.region
    AWS_DEPLOY_ROLE = aws_iam_role.deploy.arn
    ECR_REPOSITORY  = aws_ecr_repository.api.repository_url
    RELEASE_BUCKET  = aws_s3_bucket.releases.bucket
    INSTANCE_ID     = aws_instance.api.id
    API_URL         = "https://${local.api_host}"
  }
}
