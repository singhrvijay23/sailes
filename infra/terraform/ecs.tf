resource "aws_ecr_repository" "app" {
  for_each             = toset(["api", "console"])
  name                 = "sailes/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "console", "db-bootstrap"])
  name              = "/sailes/${var.environment}/${each.key}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# --- IAM

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: pull images, write logs, read secrets at task start.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.external.arn] },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = [aws_kms_key.main.arn] },
    ]
  })
}

# API task role: wrap and unwrap AI-key data keys with KMS. Nothing else.
resource "aws_iam_role" "api_task" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api_kms" {
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["kms:Encrypt", "kms:Decrypt"]
      Resource  = [aws_kms_key.main.arn]
      Condition = { StringEquals = { "kms:EncryptionContext:app" = "sailes", "kms:EncryptionContext:purpose" = "ai-credential" } }
    }]
  })
}

resource "aws_iam_role" "console_task" {
  name               = "${local.name}-console-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# --- Task definitions

locals {
  api_url     = "https://${var.api_domain}"
  console_url = "https://${var.console_domain}"
  app_secret  = aws_secretsmanager_secret.app.arn
  ext_secret  = aws_secretsmanager_secret.external.arn
  api_secrets = concat(
    [for k in ["DATABASE_URL", "REDIS_URL", "JWT_SECRET"] : { name = k, valueFrom = "${local.app_secret}:${k}::" }],
    [for k in ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STARTER_MONTHLY", "STRIPE_PRICE_STARTER_ANNUAL", "STRIPE_PRICE_PRO_MONTHLY", "STRIPE_PRICE_PRO_ANNUAL", "STRIPE_PRICE_ENTERPRISE_MONTHLY", "STRIPE_PRICE_ENTERPRISE_ANNUAL", "MANAGED_AI_API_KEY"] : { name = k, valueFrom = "${local.ext_secret}:${k}::" }],
  )
  log_config = { for k, g in aws_cloudwatch_log_group.app : k => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = g.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = k }
  } }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "api"
    image        = "${aws_ecr_repository.app["api"].repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "4000" },
      { name = "PUBLIC_API_URL", value = local.api_url },
      { name = "CONSOLE_ORIGIN", value = local.console_url },
      { name = "KMS_KEY_ID", value = aws_kms_key.main.arn },
      { name = "RUN_WORKERS", value = "true" },
      { name = "MANAGED_AI_PROVIDER", value = var.managed_ai_provider },
      { name = "LOG_LEVEL", value = "info" },
    ]
    secrets          = local.api_secrets
    logConfiguration = local.log_config["api"]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:4000/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_task_definition" "console" {
  family                   = "${local.name}-console"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.console_task.arn
  container_definitions = jsonencode([{
    name             = "console"
    image            = "${aws_ecr_repository.app["console"].repository_url}:${var.image_tag}"
    essential        = true
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    environment      = [{ name = "NODE_ENV", value = "production" }]
    logConfiguration = local.log_config["console"]
  }])
}

# One-off: create the app role, database and extensions. Run once after the first apply (see README).
resource "aws_ecs_task_definition" "db_bootstrap" {
  family                   = "${local.name}-db-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name      = "bootstrap"
    image     = "${aws_ecr_repository.app["api"].repository_url}:${var.image_tag}"
    essential = true
    command   = ["node", "dist/scripts/bootstrap-db.js"]
    secrets = [
      { name = "ADMIN_DATABASE_URL", valueFrom = "${local.app_secret}:ADMIN_DATABASE_URL::" },
      { name = "APP_DB_PASSWORD", valueFrom = "${local.app_secret}:APP_DB_PASSWORD::" },
    ]
    logConfiguration = local.log_config["db-bootstrap"]
  }])
}

# --- Services

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.api_desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "console" {
  name            = "console"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.console.arn
  desired_count   = var.console_desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.console.arn
    container_name   = "console"
    container_port   = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.http]
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = 10
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
