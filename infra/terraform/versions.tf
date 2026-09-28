terraform {
  # 1.10 for S3-native state locking (use_lockfile) - no DynamoDB table.
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # The state bucket is the one thing Terraform cannot create for itself,
  # so it is made once by hand - see infra/README.md, "Bootstrap". Backend
  # blocks cannot read variables, which is why the name is written out
  # here and passed with -backend-config instead.
  backend "s3" {
    key          = "porchlight/prod/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "porchlight"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment. The token needs
# Zone:DNS:Edit on this one zone and nothing else.
provider "cloudflare" {}
