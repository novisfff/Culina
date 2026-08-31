#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const inputPath = process.env.CLASSIFICATION_ARTIFACT_PATH || '.artifacts/pr-gate-classification.json';
const reportPath = process.env.CLASSIFICATION_AUDIT_REPORT_PATH || '.artifacts/pr-gate-classification-audit.md';

function readClassification() {
  try {
    return JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (error) {
    return {
      risk: 'unknown',
      domains: [],
      changedFiles: [],
      gates: {},
      reasons: [`无法读取分类结果：${error instanceof Error ? error.message : error}`],
      auditError: true,
    };
  }
}

export function buildAuditReport(result) {
  const selected = Object.entries(result.gates ?? {})
    .filter(([, enabled]) => enabled)
    .map(([gate]) => gate);
  const warnings = [];
  if (result.auditError) warnings.push(...result.reasons);
  if (result.full) warnings.push('本次分类升级为 full；如果这是常规业务改动，请评估是否需要补充目录规则。');
  if ((result.reasons ?? []).some((reason) => reason.startsWith('未知路径'))) {
    warnings.push('存在未知路径，已按 fail-closed 处理；建议在后续维护窗口补充目录规则。');
  }

  return [
    '# PR 门禁分类审计',
    '',
    `- 风险：**${result.risk ?? 'unknown'}**`,
    `- 业务域：${result.domains?.length ? result.domains.join('、') : '文档/未识别'}`,
    `- 改动文件：${result.changedFiles?.length ?? 0}`,
    `- 选中门禁：${selected.length ? selected.join('、') : '无业务门禁'}`,
    `- 审计结论：${warnings.length ? '需关注（不阻断）' : '正常'}`,
    '',
    '关注项：',
    ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ['- 无']),
    '',
    '该报告仅用于发现分类漂移，不改变 PR Gate 结论。',
  ].join('\n');
}

export function main() {
  const result = readClassification();
  const report = buildAuditReport(result);
  const separator = reportPath.lastIndexOf('/');
  if (separator > 0) mkdirSync(reportPath.slice(0, separator), { recursive: true });
  writeFileSync(reportPath, `${report}\n`, 'utf8');
  for (const line of report.split('\n').filter((line) => line.startsWith('- '))) {
    if (line.includes('需关注')) console.warn(`::warning title=PR gate classification audit::${line.slice(2)}`);
  }
  console.log(report);
  return { result, report };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
