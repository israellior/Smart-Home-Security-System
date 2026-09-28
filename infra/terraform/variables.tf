variable "region" {
  description = "Same region as the Atlas cluster, so every query stays in-region."
  type        = string
  default     = "eu-west-1"
}

variable "domain" {
  description = "The apex domain bought on Cloudflare, e.g. porchlight.dev. The API lives at api.<domain> and the app at the apex."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare dashboard -> the domain -> Overview -> Zone ID (right-hand column)."
  type        = string
}

variable "github_repository" {
  description = "owner/name. Only workflows from this repo's 'production' environment can assume the deploy role."
  type        = string
  default     = "israellior/Smart-Home-Security-System"
}

# GitHub's OIDC subject names the owner and repository by name *and* by
# immutable ID: repo:owner@<owner id>/name@<repo id>:environment:production.
# The IDs are what make the trust unforgeable - rename or delete the repo
# and recreate one with the same name, and the new one gets a new ID, so
# its workflows cannot assume this role. Both are public:
#   curl https://api.github.com/repos/<owner>/<name>  ->  .owner.id, .id
variable "github_owner_id" {
  type    = number
  default = 272283128
}

variable "github_repository_id" {
  type    = number
  default = 1354714682
}

variable "alert_email" {
  description = "Receives budget alerts and Let's Encrypt expiry notices."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Alert at 80% of this, actual or forecast."
  type        = number
  default     = 20
}

variable "instance_type" {
  description = "Graviton (arm64). t4g.small is on AWS's free trial through 2026-12-31."
  type        = string
  default     = "t4g.small"
}
