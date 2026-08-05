---
schema_version: model_usage_first_launch_report.v2
generated_at: 2026-08-05T13:15:21.460186Z
git_commit: 47b2e27d789011df2a6a6bd8409cab2a6ce8b409
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
      "sha256": "83d6bf9f76d0285620f4149a63747c8ac37b8d211b3bbce0a4f0342449be4cc3",
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
      "sha256": "d3c9fcd25f1c7b3f0d2d8db55a35688ca3e4d7876a7dc7c98baad47192cd9044",
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
      "sha256": "8703c7c642b3d11c35bfcecaffaf59d35d2d7b8dff775eb25b2b74634ba1a5f1",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
        "frontendBuild": {
          "command": "npm run frontend:build",
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
          "commit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
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
      "sha256": "57bf2f451783ca813e22e760a892b52a94c5465fe46e45924ddb198078d15e2f",
      "status": "passed"
    },
    "rollup": {
      "exitCode": 0,
      "revision": 1,
      "rows": 65,
      "sha256": "73d8b57cd2b87e8a9428b0dc4be3a135d8596f511b9bbaa84cf7e857d0f925ff",
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
  "generatedAt": "2026-08-05T13:15:21.460186Z",
  "gitCommit": "47b2e27d789011df2a6a6bd8409cab2a6ce8b409",
  "readyForFirstOpen": false,
  "schemaVersion": "model_usage_first_launch_report.v2",
  "status": "blocked"
}
```
