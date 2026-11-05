# Copy to prod.tfvars (git-ignored) and adjust.
region                = "us-east-1"
environment           = "prod"
api_domain            = "api.sailes.ai"
console_domain        = "app.sailes.ai"
certificate_arn       = "" # ACM certificate ARN covering both domains
image_tag             = "latest"
api_desired_count     = 2
console_desired_count = 1
db_multi_az           = false # true before public launch
managed_ai_provider   = "openai"
alarm_email           = ""
