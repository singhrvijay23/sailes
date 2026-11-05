output "load_balancer_dns" {
  description = "Point both domains here (CNAME, or Route 53 alias)."
  value       = aws_lb.main.dns_name
}

output "ecr_api" {
  value = aws_ecr_repository.app["api"].repository_url
}

output "ecr_console" {
  value = aws_ecr_repository.app["console"].repository_url
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "private_subnets" {
  value = aws_subnet.private[*].id
}

output "app_security_group" {
  value = aws_security_group.app.id
}

output "external_secret_name" {
  description = "Fill Stripe keys, price ids and the managed AI key here."
  value       = aws_secretsmanager_secret.external.name
}

output "stripe_webhook_url" {
  value = "https://${var.api_domain}/v1/billing/webhook"
}
