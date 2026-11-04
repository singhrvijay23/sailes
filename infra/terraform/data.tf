# --- KMS: one key wraps merchant AI-key data keys (app) and encrypts the database, cache and secrets.

resource "aws_kms_key" "main" {
  description             = "${local.name} encryption key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

# --- Postgres 16 with pgvector (RDS supports the vector extension natively).

resource "random_password" "db_admin" {
  length  = 32
  special = false
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "main" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = "16"
  instance_class               = var.db_instance_class
  allocated_storage            = 50
  max_allocated_storage        = 500
  storage_type                 = "gp3"
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.main.arn
  db_name                      = "postgres"
  username                     = "sailes_admin"
  password                     = random_password.db_admin.result
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = [aws_security_group.data.id]
  parameter_group_name         = aws_db_parameter_group.pg16.name
  multi_az                     = var.db_multi_az
  backup_retention_period      = 14
  backup_window                = "07:00-08:00"
  maintenance_window           = "sun:08:30-sun:09:30"
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-final"
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
  copy_tags_to_snapshot        = true
}

# --- Redis for BullMQ (catalog embedding jobs). TLS and auth token on.

resource "random_password" "redis" {
  length  = 40
  special = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = local.name
  description                = "SAILES job queue"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  # BullMQ needs keys to stay until processed.
  parameter_group_name     = "default.redis7"
  snapshot_retention_limit = 1
}

# --- Secrets. Terraform generates the internal ones; operators fill the external ones
#     (Stripe, managed AI key) in the console or CLI, and Terraform leaves them alone afterwards.

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name       = "${local.name}/app"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL       = "postgres://sailes:${random_password.db_app.result}@${aws_db_instance.main.address}:5432/sailes"
    REDIS_URL          = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
    JWT_SECRET         = random_password.jwt.result
    APP_DB_PASSWORD    = random_password.db_app.result
    ADMIN_DATABASE_URL = "postgres://sailes_admin:${random_password.db_admin.result}@${aws_db_instance.main.address}:5432/postgres"
  })
}

resource "aws_secretsmanager_secret" "external" {
  name       = "${local.name}/external"
  kms_key_id = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "external" {
  secret_id = aws_secretsmanager_secret.external.id
  secret_string = jsonencode({
    STRIPE_SECRET_KEY               = ""
    STRIPE_WEBHOOK_SECRET           = ""
    STRIPE_PRICE_STARTER_MONTHLY    = ""
    STRIPE_PRICE_STARTER_ANNUAL     = ""
    STRIPE_PRICE_PRO_MONTHLY        = ""
    STRIPE_PRICE_PRO_ANNUAL         = ""
    STRIPE_PRICE_ENTERPRISE_MONTHLY = ""
    STRIPE_PRICE_ENTERPRISE_ANNUAL  = ""
    MANAGED_AI_API_KEY              = ""
  })
  lifecycle {
    ignore_changes = [secret_string]
  }
}
