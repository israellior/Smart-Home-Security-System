# Runtime configuration lives in SSM Parameter Store, in two paths:
#
#   /porchlight/prod/app/<NAME>    the API's environment, one parameter per variable
#   /porchlight/prod/proxy/<NAME>  Caddy's, which never sees the app's secrets
#
# deploy.sh reads each path into an env file at release time, so changing
# a value is `put-parameter` plus a redeploy - no image rebuild.
#
# Only the non-secret values are declared here. The secrets (MONGODB_URI,
# JWT_SECRET, CLAIM_CODE_PEPPER, the LiveKit and R2 keys) are put by hand
# with infra/scripts/put-secret.sh, because anything Terraform creates is
# written in plain text into its state file. deploy.sh refuses to release
# while any required one is missing, and says which.

locals {
  api_host   = "api.${var.domain}"
  app_origin = "https://${var.domain}"
}

resource "aws_ssm_parameter" "public_api_url" {
  name  = "${local.param_prefix}/app/PUBLIC_API_URL"
  type  = "String"
  value = "https://${local.api_host}"
}

resource "aws_ssm_parameter" "client_origin" {
  name  = "${local.param_prefix}/app/CLIENT_ORIGIN"
  type  = "String"
  value = local.app_origin
}

resource "aws_ssm_parameter" "api_domain" {
  name  = "${local.param_prefix}/proxy/API_DOMAIN"
  type  = "String"
  value = local.api_host
}

resource "aws_ssm_parameter" "acme_email" {
  name  = "${local.param_prefix}/proxy/ACME_EMAIL"
  type  = "String"
  value = var.alert_email
}

resource "aws_ssm_parameter" "log_group" {
  name  = "${local.param_prefix}/proxy/LOG_GROUP"
  type  = "String"
  value = aws_cloudwatch_log_group.app.name
}

# ---------------------------------------------------------------------
# DNS: api.<domain> -> the Elastic IP.
#
# DNS-only (grey cloud), not proxied through Cloudflare. Caddy terminates
# TLS itself with a Let's Encrypt certificate, and the doorbells' sockets
# go straight to it. The frontend's records are made by Cloudflare Pages
# when its custom domain is attached - see infra/README.md.
# ---------------------------------------------------------------------

resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = local.api_host
  type    = "A"
  content = aws_eip.api.public_ip
  ttl     = 300
  proxied = false
}

# ---------------------------------------------------------------------
# Budget. The first line of defence against a bill, and the one AWS
# onboarding task that also earns Free Plan credits.
# ---------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "porchlight-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
