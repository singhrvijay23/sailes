variable "region" {
  description = "AWS region. US first (decision 2026-11-04)."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "prod or staging. Used in resource names."
  type        = string
  default     = "prod"
}

variable "api_domain" {
  description = "Public hostname of the API and widget, e.g. api.sailes.ai"
  type        = string
}

variable "console_domain" {
  description = "Public hostname of the merchant console, e.g. app.sailes.ai"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate (in var.region) covering both domains. Empty = HTTP only, for a first smoke test."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Image tag to deploy from the ECR repositories (set by CI to the git SHA)."
  type        = string
  default     = "latest"
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "console_desired_count" {
  type    = number
  default = 1
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_multi_az" {
  description = "Standby in a second zone. Turn on before public launch."
  type        = bool
  default     = false
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "managed_ai_provider" {
  description = "Provider behind SAILES AI credits: openai, gemini or anthropic"
  type        = string
  default     = "openai"
}

variable "alarm_email" {
  description = "Email for CloudWatch alarms (5xx, CPU, database storage). Empty = no alarms topic subscription."
  type        = string
  default     = ""
}
