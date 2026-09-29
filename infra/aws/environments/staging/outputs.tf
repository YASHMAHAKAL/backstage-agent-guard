output "cluster_name" { value = aws_eks_cluster.staging.name }
output "cluster_endpoint" { value = aws_eks_cluster.staging.endpoint }
output "vpc_id" { value = aws_vpc.staging.id }
output "runtime_secret_arn" { value = aws_secretsmanager_secret.runtime.arn }
output "secret_sync_role_arn" { value = aws_iam_role.pod["secrets"].arn }
output "ingress_role_arn" { value = aws_iam_role.pod["ingress"].arn }
