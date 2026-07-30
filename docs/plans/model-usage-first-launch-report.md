---
schema_version: model_usage_first_launch_report.v1
generated_at: 2026-07-30T21:38:58.627572Z
git_commit: 5af8b0c1f5e1d81b151f3fd5f3524a3674aafeae
ready_for_first_open: false
status: blocked
blockers:
  - counter_audit_not_run
  - health_command_failed
  - health_not_healthy
  - model_usage_price_coverage_missing
  - provider_smoke_not_passed
  - receipt_integrity_keyring_required
  - reference_performance_not_run
  - rollup_not_run
  - visual_review_not_run
---

# 模型用量首发门禁报告

本报告由 `generate_model_usage_launch_report.py` 自动生成。它只汇总机器读取的安全证据字段和哈希，不复制 Provider 请求、响应、媒体地址、凭据或用户内容。

当前机器判定：`blocked，不能首次对外开放`。

## 机器可读证据

```json
{
  "blockers": [
    "counter_audit_not_run",
    "health_command_failed",
    "health_not_healthy",
    "model_usage_price_coverage_missing",
    "provider_smoke_not_passed",
    "receipt_integrity_keyring_required",
    "reference_performance_not_run",
    "rollup_not_run",
    "visual_review_not_run"
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
        "billingModel": "qwen3-asr-flash-realtime",
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
      "exitCode": null,
      "sha256": null,
      "status": "not_run"
    },
    "firstLaunchPreflight": {
      "activeProviderAttempts": 0,
      "blockers": [
        "receipt_integrity_keyring_required",
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
      "receiptIntegrityError": "receipt_integrity_keyring_required",
      "receiptIntegrityKeyringValid": false,
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
      "sha256": "35351b57fc97aed25a65be2c996ceec2083d90726b19dbc712c71debc6d3570c",
      "status": "blocked"
    },
    "providerSendCoverage": {
      "exitCode": 0,
      "modelProviderSendPointCount": 19,
      "nonModelRemoteSendPointCount": 7,
      "status": "covered"
    },
    "providerSmoke": {
      "capabilityCount": 7,
      "executionMode": "not_run",
      "sha256": "601133c8812d87222259fc283c6006b761cb3121bc7ecaebd65ba92fa2a97269",
      "status": "blocked"
    },
    "referencePerformance": {
      "exitCode": null,
      "sha256": null,
      "status": "not_run"
    },
    "rollup": {
      "exitCode": null,
      "sha256": null,
      "status": "not_run"
    },
    "visualReview": {
      "sha256": null,
      "status": "not_run",
      "viewports": []
    }
  },
  "generatedAt": "2026-07-30T21:38:58.627572Z",
  "gitCommit": "5af8b0c1f5e1d81b151f3fd5f3524a3674aafeae",
  "readyForFirstOpen": false,
  "schemaVersion": "model_usage_first_launch_report.v1",
  "status": "blocked"
}
```
