---
schema_version: model_usage_first_launch_report.v2
generated_at: 2026-08-05T09:04:49.330078Z
git_commit: e927013e0887f662f2171641e951fb427fd959f3
ready_for_first_open: false
status: blocked
blockers:
  - health_command_failed
  - health_not_healthy
  - model_usage_price_coverage_missing
  - provider_smoke_not_run
  - reference_performance_not_run
  - rollup_not_run
  - visual_review_not_passed
---

# 模型用量首发门禁报告

本报告由 `generate_model_usage_launch_report.py` 自动生成。它只汇总机器读取的安全证据字段和哈希，不复制 Provider 请求、响应、媒体地址、凭据或用户内容。

当前机器判定：`blocked，不能首次对外开放`。

## 机器可读证据

```json
{
  "blockers": [
    "health_command_failed",
    "health_not_healthy",
    "model_usage_price_coverage_missing",
    "provider_smoke_not_run",
    "reference_performance_not_run",
    "rollup_not_run",
    "visual_review_not_passed"
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
      "sha256": "0e9abe0df0257ae04032dddf49fde5589c29b5bb5e89c473333208b79e64e5cc",
      "status": "passed"
    },
    "firstLaunchPreflight": {
      "activeProviderAttempts": 0,
      "blockers": [
        "model_usage_price_coverage_missing"
      ],
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
        "healthy": false,
        "missingCapabilities": [
          "embedding",
          "image_generation",
          "llm",
          "realtime_audio",
          "rerank",
          "stt",
          "tts"
        ],
        "priceVersionId": null
      },
      "ready": false,
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
      "exitCode": 2,
      "healthy": false,
      "sha256": "1bdf6e5675823224e660c90c60a37139b43c510c14d9e1dc85729cfa97c337d1",
      "status": "blocked"
    },
    "providerSendCoverage": {
      "exitCode": 0,
      "modelProviderSendPointCount": 19,
      "nonModelRemoteSendPointCount": 7,
      "status": "covered"
    },
    "providerSmoke": {
      "sha256": null,
      "status": "not_run"
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
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
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
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
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
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
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
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
          "environment": {
            "architecture": "arm64",
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
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
          "environment": {
            "architecture": "arm64",
            "node": "20.18",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendE2EP0": {
          "command": "npm run frontend:e2e:p0",
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
          "environment": {
            "architecture": "arm64",
            "browser": "chromium",
            "node": "20.18",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendQuality": {
          "command": "npm run frontend:quality",
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
          "environment": {
            "architecture": "arm64",
            "node": "20.18",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendSmoke": {
          "command": "npm run frontend:smoke",
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
          "environment": {
            "architecture": "arm64",
            "browser": "chromium",
            "node": "20.18",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "frontendStyleTokens": {
          "command": "npm --prefix frontend run check:style-tokens",
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
          "environment": {
            "architecture": "arm64",
            "node": "20.18",
            "os": "macos",
            "runner": "local"
          },
          "exitCode": 0,
          "status": "passed"
        },
        "mysqlMigrationConcurrency": {
          "command": "model-usage MySQL migration/concurrency/query-plan suite",
          "commit": "e927013e0887f662f2171641e951fb427fd959f3",
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
      "sha256": "381eef87e6eaa1afac6373358be180a7490b51bd3356efdaed8ffab962e43997",
      "status": "passed"
    },
    "rollup": {
      "exitCode": null,
      "sha256": null,
      "status": "not_run"
    },
    "visualReview": {
      "sha256": "df189067f8ebf8f95d7773005d748924c775906995a811c65f2d14695ca84a53",
      "status": "blocked",
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
  "generatedAt": "2026-08-05T09:04:49.330078Z",
  "gitCommit": "e927013e0887f662f2171641e951fb427fd959f3",
  "readyForFirstOpen": false,
  "schemaVersion": "model_usage_first_launch_report.v2",
  "status": "blocked"
}
```
