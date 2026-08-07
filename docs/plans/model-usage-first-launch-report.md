---
schema_version: model_usage_first_launch_report.v2
generated_at: 2026-08-05T14:14:48.933951Z
git_commit: fdbf8d367de480f1be7f9820c9982742622473b4
ready_for_first_open: false
status: blocked
blockers:
  - reference_performance_not_run
---

# 模型用量首发门禁报告

本报告由 `generate_model_usage_launch_report.py` 自动生成。它只汇总机器读取的安全证据字段和哈希，不复制 Provider 请求、响应、媒体地址、凭据或用户内容。

当前机器判定：`blocked，不能首次对外开放`。

## 机器可读证据

```json
{
  "blockers": [
    "reference_performance_not_run"
  ],
  "evidence": {
    "configuredVariants": [
      {
        "billingModel": "text-embedding-v4",
        "capability": "embedding",
        "provider": "openai",
        "recoveryMode": "none",
        "variantKey": "dimensions=1024"
      },
      {
        "billingModel": "gpt-image-2",
        "capability": "image_generation",
        "provider": "openai",
        "recoveryMode": "none",
        "variantKey": "mode=reference|size=1536*1152|quality=standard"
      },
      {
        "billingModel": "gpt-image-2",
        "capability": "image_generation",
        "provider": "openai",
        "recoveryMode": "none",
        "variantKey": "mode=text|size=1536*1152|quality=standard"
      },
      {
        "billingModel": "gpt-5.6-terra",
        "capability": "llm",
        "provider": "openai-compatible",
        "recoveryMode": "none",
        "variantKey": "default"
      },
      {
        "billingModel": "realtime-duplex-v1|input=qwen3-asr-flash-realtime|output=qwen3-tts-flash-realtime",
        "capability": "realtime_audio",
        "provider": "dashscope",
        "recoveryMode": "none",
        "variantKey": "voice=default"
      },
      {
        "billingModel": "qwen3-rerank",
        "capability": "rerank",
        "provider": "dashscope",
        "recoveryMode": "none",
        "variantKey": "top_n=50"
      },
      {
        "billingModel": "qwen3-asr-flash",
        "capability": "stt",
        "provider": "dashscope",
        "recoveryMode": "none",
        "variantKey": "format=auto"
      },
      {
        "billingModel": "qwen3-tts-flash",
        "capability": "tts",
        "provider": "dashscope",
        "recoveryMode": "none",
        "variantKey": "voice=Cherry"
      }
    ],
    "counterAudit": {
      "exitCode": 0,
      "healthy": true,
      "sha256": "680103c74a43c4400d4d72891a31e0d6fb684faaabff7e7ad9b4bd74193d1fd2",
      "status": "passed"
    },
    "firstLaunchPreflight": {
      "activeProviderAttempts": 0,
      "blockers": [],
      "configuredCapabilities": [
        "embedding",
        "image_generation",
        "llm",
        "realtime_audio",
        "rerank",
        "stt",
        "tts"
      ],
      "databaseAtHead": true,
      "databaseMigrationHeads": [
        "5f6a7b8c9d0e"
      ],
      "failOpenProofTtlValid": true,
      "familiesMissingDefaultPolicies": 0,
      "familiesMissingSubjects": 0,
      "invalidRecoveryPolicies": [],
      "maintenanceEnabled": true,
      "migrationError": null,
      "missingCapabilities": [],
      "missingGuardrailMeterCoverage": [],
      "missingIdempotencyUniques": [],
      "missingSchemaTables": [],
      "priceCoverage": {
        "error": null,
        "healthy": true,
        "missingCapabilities": [],
        "priceVersionId": "model-usage-price-276f37d0e7d4"
      },
      "ready": true,
      "receiptIntegrityError": null,
      "receiptIntegrityKeyringValid": true,
      "registryErrors": [],
      "requiredCapabilities": [
        "embedding",
        "image_generation",
        "llm",
        "realtime_audio",
        "rerank",
        "stt",
        "tts"
      ],
      "sdkRetryConfigurationGaps": [],
      "sourceMigrationHeads": [
        "5f6a7b8c9d0e"
      ],
      "staleRegistrySendPoints": [],
      "unregisteredSendPoints": [],
      "unsupportedLeaseBoundaryCumulativeMeters": []
    },
    "health": {
      "exitCode": 0,
      "healthy": true,
      "sha256": "a3d9b843e6eb8ce8d00f87c51960d147d274d22935a537260ad490dccbe6beda",
      "status": "passed"
    },
    "providerSendCoverage": {
      "exitCode": 0,
      "modelProviderSendPointCount": 19,
      "nonModelRemoteSendPointCount": 7,
      "status": "covered"
    },
    "providerSmoke": {
      "capabilityCount": 7,
      "executionMode": "real_provider",
      "sha256": "188481fb42ceed1294c877a855e7610125aee3b980af2eadf03843bd05b1a22d",
      "status": "passed"
    },
    "referencePerformance": {
      "exitCode": null,
      "sha256": null,
      "status": "not_run"
    },
    "requiredVerification": {
      "commands": {
        "backendQuality": {
          "command": "npm run backend:quality",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "database": "sqlite",
            "os": "macos",
            "python": "3.12",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "dispatchPolicyInterleaving": {
          "command": "dispatch-policy MySQL interleaving suite",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "containerRuntime": "docker",
            "database": "mysql",
            "os": "macos",
            "python": "3.12",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "dockerBuild": {
          "command": "docker compose -f deploy/docker-compose.yml build backend frontend",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "containerRuntime": "docker",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "focusedModelUsageTests": {
          "command": "pytest tests/model_usage -q",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "containerRuntime": "docker",
            "database": "mysql",
            "os": "macos",
            "python": "3.12",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendBuild": {
          "command": "npm run frontend:build",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "node": "22",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendE2EP0": {
          "command": "npm run frontend:e2e:p0",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "browser": "chromium",
            "node": "22",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendQuality": {
          "command": "npm run frontend:quality",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "browser": "none",
            "node": "22",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendSmoke": {
          "command": "npm run frontend:smoke",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "browser": "chromium",
            "node": "22",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendStyleTokens": {
          "command": "npm --prefix frontend run check:style-tokens",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "node": "22",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "mysqlMigrationConcurrency": {
          "command": "model-usage MySQL migration/concurrency/query-plan suite",
          "commit": "fdbf8d367de480f1be7f9820c9982742622473b4",
          "environment": {
            "architecture": "arm64",
            "containerRuntime": "docker",
            "database": "mysql",
            "os": "macos",
            "python": "3.12",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        }
      },
      "sha256": "9fd27c14724c78603c59bf6785b842e92e72ad02d648f861999e72122e55b22c",
      "status": "passed"
    },
    "rollup": {
      "exitCode": 0,
      "revision": 2,
      "rows": 65,
      "sha256": "fa02be96dca745bd70f82b30c26c36cec2a09c62e41c63305bb2ce7c25299e07",
      "status": "passed"
    },
    "visualReview": {
      "sha256": "8424bd826819e0fc4b3917e3007411a89c701782b6e0d49560d9bd594fde70e0",
      "status": "passed",
      "unresolvedP0P1": 0,
      "viewports": [
        "1024x768",
        "1440x900",
        "360x800",
        "375x812",
        "390x844",
        "430x932",
        "768x1024"
      ]
    }
  },
  "generatedAt": "2026-08-05T14:14:48.933951Z",
  "gitCommit": "fdbf8d367de480f1be7f9820c9982742622473b4",
  "readyForFirstOpen": false,
  "schemaVersion": "model_usage_first_launch_report.v2",
  "status": "blocked"
}
```
