output "agent_runtime_arn" {
  description = "IAM-authenticated AgentCore runtime ARN."
  value       = aws_bedrockagentcore_agent_runtime.agent.agent_runtime_arn
}

output "artifact_bucket" {
  description = "Private bucket for AgentCore deployment artifacts."
  value       = aws_s3_bucket.artifacts.id
}
