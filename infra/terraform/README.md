# SAILES on AWS (US)

Terraform for production hosting in one US region (default `us-east-1`).

```
                 ┌──────────── ALB (HTTPS, host routing) ────────────┐
 shoppers ──►    │ api.<domain>  ─► ECS Fargate "api" (2-10 tasks)   │──► RDS Postgres 16 + pgvector (encrypted, backups 14 days)
 merchants ──►   │ app.<domain>  ─► ECS Fargate "console" (1 task)   │──► ElastiCache Redis (TLS + auth, BullMQ jobs)
                 └───────────────────────────────────────────────────┘──► KMS (AI-key vault, disk and secret encryption)
                                     private subnets ──► NAT ──► OpenAI / Gemini / Anthropic / Stripe
```

| File | What |
| --- | --- |
| `network.tf` | VPC, 2 public + 2 private subnets in two zones, one NAT gateway, security groups |
| `data.tf` | KMS key, RDS Postgres, ElastiCache Redis, Secrets Manager secrets |
| `ecs.tf` | ECR repositories, ECS cluster, task definitions (api, console, one-off db-bootstrap), services, autoscaling, IAM |
| `alb.tf` | Load balancer, HTTPS listener, host routing |
| `monitoring.tf` | Alarms: API 5xx, unhealthy API, database CPU and storage, to an SNS topic (email) |

**Security choices:** tasks run in private subnets; only the load balancer is public. The API task role can use KMS only with the SAILES encryption context, for AI keys. Database TLS is forced and verified against the RDS CA bundle baked into the image. The app connects as a non-superuser role so row-level security applies. Secrets live in Secrets Manager, encrypted with the same KMS key, and are injected at task start.

**Rough monthly cost at launch** (us-east-1, on-demand, before traffic): about $250-300. NAT gateway ~$35, ALB ~$20, RDS db.t4g.medium single-AZ ~$55 plus storage, Redis cache.t4g.micro ~$12, Fargate 2 API tasks (1 vCPU/2 GB) + 1 console ~$110, KMS, logs and Secrets Manager ~$10. Multi-AZ RDS adds ~$55.

## First deployment

You need: an AWS account (TNMI), the AWS CLI signed in with admin rights, Terraform 1.9+, Docker, and the two domain names.

1. **Certificate.** In ACM (same region) request one certificate for both domains (`api.<domain>`, `app.<domain>`) and validate it by DNS.
2. **Variables.** `cp example.tfvars prod.tfvars` and fill the domains and `certificate_arn`.
3. **State bucket (once).** Create an S3 bucket for Terraform state with versioning on, then uncomment the `backend "s3"` block in `versions.tf`.
4. **Create the registries first**, then push images:
   ```bash
   terraform init
   terraform apply -var-file=prod.tfvars -target=aws_ecr_repository.app
   aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
   TAG=$(git rev-parse --short HEAD)
   docker build -f apps/api/Dockerfile -t <ecr_api>:$TAG .
   docker build -f apps/console/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.<domain> -t <ecr_console>:$TAG .
   docker push <ecr_api>:$TAG && docker push <ecr_console>:$TAG
   ```
5. **Everything else:** `terraform apply -var-file=prod.tfvars -var image_tag=$TAG`. RDS takes about 10 minutes.
6. **Database setup (once):** run the bootstrap task. It creates the `sailes` app role, the `sailes` database and the pgvector, pg_trgm and unaccent extensions. The API runs migrations itself on start.
   ```bash
   aws ecs run-task --cluster sailes-prod --launch-type FARGATE --task-definition sailes-prod-db-bootstrap \
     --network-configuration "awsvpcConfiguration={subnets=[<private_subnet>],securityGroups=[<app_security_group>]}"
   aws ecs update-service --cluster sailes-prod --service api --force-new-deployment
   ```
7. **DNS:** point both domains to `load_balancer_dns` (CNAME, or a Route 53 alias).
8. **Stripe and SAILES AI:** fill the `sailes-prod/external` secret (Stripe live secret key, webhook signing secret, the six price ids, and the managed AI provider key), then redeploy the API (`--force-new-deployment`). In Stripe, add the webhook endpoint `stripe_webhook_url` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, and turn on the customer portal (plan switching between the three prices, cancellation at period end).

## Deploying a new version

Build and push both images with a new tag, then `terraform apply -var-file=prod.tfvars -var image_tag=<tag>`. ECS rolls tasks one by one and rolls back automatically if the new ones fail health checks.

## Before public launch (Jan 4)

* `db_multi_az = true`
* Move API rate limits to Redis (they are per task today)
* Add a second NAT gateway if one zone's outage should not stop AI calls
* WAF on the load balancer (AWS managed common rules + rate rule on `/v1/chat`)
