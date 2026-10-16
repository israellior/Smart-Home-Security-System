# ---------------------------------------------------------------------
# Account email (password resets) through Amazon SES, from no-reply@<domain>.
#
# What makes it land in an inbox rather than spam is that the domain
# vouches for SES three ways, all published here in Cloudflare:
#
#   DKIM      three CNAMEs; SES signs every message with keys it rotates
#             itself ("Easy DKIM")
#   MAIL FROM bounces go to mail.<domain>, whose SPF names SES, so SPF
#             passes *for this domain* and not just for amazonses.com
#   DMARC     tells receivers both of those must line up with the From
#             address. p=none to start: it asks for nothing to be
#             rejected while the setup is new.
#
# A new account is in the SES sandbox and can only send to addresses it
# has verified. Getting out is a request made once, by hand - see
# infra/README.md, "Account email".
# ---------------------------------------------------------------------

locals {
  mail_from_domain = "mail.${var.domain}"
  email_from       = "Porchlight <no-reply@${var.domain}>"
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Easy DKIM always issues exactly three tokens. The count is written out
# because the tokens themselves are only known after apply, and count
# cannot depend on that.
resource "cloudflare_dns_record" "ses_dkim" {
  count   = 3
  zone_id = var.cloudflare_zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  content = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"
  ttl     = 1800
  proxied = false
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity   = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain = local.mail_from_domain

  # If the MX below ever goes missing, fall back to amazonses.com rather
  # than refusing to send - mail still goes out, only less well aligned.
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "cloudflare_dns_record" "ses_mail_from_mx" {
  zone_id  = var.cloudflare_zone_id
  name     = local.mail_from_domain
  type     = "MX"
  content  = "feedback-smtp.${var.region}.amazonses.com"
  priority = 10
  ttl      = 1800
  proxied  = false
}

resource "cloudflare_dns_record" "ses_mail_from_spf" {
  zone_id = var.cloudflare_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 1800
  proxied = false
}

# There was no DMARC record on the zone when this was written. A domain
# must have exactly one; if one is ever added by hand in the dashboard,
# delete one of the two.
resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=none\""
  ttl     = 1800
  proxied = false
}

resource "aws_ssm_parameter" "email_from" {
  name  = "${local.param_prefix}/app/EMAIL_FROM"
  type  = "String"
  value = local.email_from
}
