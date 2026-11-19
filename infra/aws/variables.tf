variable "aws_account_id" {
  description = "AWS account ID allowed for this deployment."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Region used by the Japan Nova inference profile."
  type        = string
  default     = "ap-northeast-1"
  validation {
    condition     = var.aws_region == "ap-northeast-1"
    error_message = "This development configuration is currently restricted to ap-northeast-1."
  }
}

variable "agent_name" {
  description = "AgentCore runtime name."
  type        = string
  default     = "konoha_schema_agent"
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,47}$", var.agent_name))
    error_message = "agent_name must start with a letter and contain only letters, digits and underscores."
  }
}
