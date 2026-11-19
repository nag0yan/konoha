data "aws_partition" "current" {}

data "archive_file" "agent" {
  type             = "zip"
  source_dir       = "${path.module}/../../dist-agent/deployment"
  output_path      = "${path.module}/../../dist-agent/agent.zip"
  output_file_mode = "0644"
}

resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "konoha-agent-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "agent" {
  bucket                 = aws_s3_bucket.artifacts.id
  key                    = "agent/${data.archive_file.agent.output_sha256}.zip"
  source                 = data.archive_file.agent.output_path
  source_hash            = data.archive_file.agent.output_base64sha256
  server_side_encryption = "AES256"

  depends_on = [aws_s3_bucket_versioning.artifacts]
}

data "aws_iam_policy_document" "agent_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:bedrock-agentcore:${var.aws_region}:${var.aws_account_id}:*"]
    }
  }
}

resource "aws_iam_role" "agent" {
  name_prefix        = "konoha-agent-"
  assume_role_policy = data.aws_iam_policy_document.agent_trust.json
}

data "aws_iam_policy_document" "agent" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.artifacts.arn}/agent/*"]
  }
  statement {
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock:${var.aws_region}:${var.aws_account_id}:inference-profile/jp.amazon.nova-2-lite-v1:0",
      "arn:${data.aws_partition.current.partition}:bedrock:ap-northeast-1::foundation-model/amazon.nova-2-lite-v1:0",
      "arn:${data.aws_partition.current.partition}:bedrock:ap-northeast-3::foundation-model/amazon.nova-2-lite-v1:0"
    ]
  }
  statement {
    actions = ["logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:PutResourcePolicy"]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/${var.agent_name}-*"
    ]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/bedrock-agentcore/runtimes/${var.agent_name}-*:log-stream:*"]
  }
  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:*"]
  }
}

resource "aws_iam_role_policy" "agent" {
  name   = "konoha-agent"
  role   = aws_iam_role.agent.id
  policy = data.aws_iam_policy_document.agent.json
}

resource "aws_bedrockagentcore_agent_runtime" "agent" {
  agent_runtime_name = var.agent_name
  description        = "Konoha schema generation agent"
  role_arn           = aws_iam_role.agent.arn

  agent_runtime_artifact {
    code_configuration {
      runtime     = "NODE_22"
      entry_point = ["index.js"]
      code {
        s3 {
          bucket     = aws_s3_bucket.artifacts.id
          prefix     = aws_s3_object.agent.key
          version_id = aws_s3_object.agent.version_id
        }
      }
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  environment_variables = {
    BEDROCK_MODEL_ID = "jp.amazon.nova-2-lite-v1:0"
    MODEL_REGION     = var.aws_region
  }

  depends_on = [aws_iam_role_policy.agent]
}
