terraform {
  required_version = ">= 1.9"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Remote state: create the bucket once, then uncomment (see README).
  # backend "s3" {
  #   bucket       = "sailes-terraform-state"
  #   key          = "prod/terraform.tfstate"
  #   region       = "us-east-1"
  #   use_lockfile = true
  #   encrypt      = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "sailes", Environment = var.environment, Owner = "TNMI", ManagedBy = "terraform" }
  }
}
