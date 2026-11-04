resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  # Chat replies stream for up to a minute.
  idle_timeout = 120
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/health"
    matcher = "200"
  }
  deregistration_delay = 30
}

resource "aws_lb_target_group" "console" {
  name        = "${local.name}-console"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/login"
    matcher = "200"
  }
  deregistration_delay = 30
}

locals {
  https = var.certificate_arn != ""
}

# HTTP redirects to HTTPS when a certificate is set; otherwise it serves directly (smoke test only).
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = local.https ? "redirect" : "forward"
    target_group_arn = local.https ? null : aws_lb_target_group.console.arn
    dynamic "redirect" {
      for_each = local.https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.console.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = local.https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    host_header {
      values = [var.api_domain]
    }
  }
}
