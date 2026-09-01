#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GATE_KEYS = Object.freeze([
  'frontend_focus',
  'frontend_typecheck',
  'frontend_full',
  'frontend_style',
  'frontend_build',
  'frontend_e2e',
  'frontend_ai_contract',
  'frontend_governance',
  'frontend_release_evidence',
  'backend_service',
  'backend_ai',
  'ai_evals',
  'backend_search',
  'backend_mysql',
  'backend_migration',
  'dependency_audit',
  'deployment_smokes',
]);

const FRONTEND_FULL_GATES = Object.freeze([
  'frontend_typecheck',
  'frontend_full',
  'frontend_style',
  'frontend_build',
  'frontend_e2e',
  'frontend_ai_contract',
  'frontend_governance',
  'frontend_release_evidence',
]);
const BACKEND_FULL_GATES = Object.freeze([
  'backend_service',
  'backend_ai',
  'ai_evals',
  'backend_search',
  'backend_mysql',
  'backend_migration',
]);

const RISK_RANK = Object.freeze({ docs: 0, unit: 1, page: 2, high: 3, full: 4 });
const FULL_FRONTEND_SCOPES = Object.freeze([
  'src/api',
  'src/app',
  'src/auth',
  'src/components',
  'src/features',
  'src/hooks',
  'src/lib',
]);

// Keep directory ownership coarse-grained. New files inherit the nearest
// directory rule; only cross-cutting or high-risk paths need explicit rules.
const FRONTEND_SCOPE_PREFIXES = Object.freeze([
  ['frontend/src/lib/', 'src/lib'],
  ['frontend/src/hooks/', 'src/hooks'],
  ['frontend/src/api/', 'src/api'],
  ['frontend/scripts/', 'scripts'],
  ['frontend/src/app/', 'src/app'],
  ['frontend/src/auth/', 'src/auth'],
]);
const FRONTEND_DOMAIN_ROOTS = Object.freeze([
  'frontend/src/components/',
  'frontend/src/features/',
]);
const FRONTEND_PAGE_FILENAME = /(?:Workspace|Dialog|Page|View)\.(?:ts|tsx)$/;
const FRONTEND_UNIT_FILENAME = /(?:model|helper|options|viewmodel)\.(?:ts|tsx)$/i;
const FRONTEND_HIGH_RISK_PATH = /(?:mobile|responsive|navigation|nav|sidebar|overlay|shell)/i;

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.?\//, '');
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

function isDocumentationPath(path) {
  return path === 'AGENTS.md' || path.startsWith('docs/') || /\.(md|mdx)$/i.test(path);
}

function isFrontendPath(path) {
  return path.startsWith('frontend/');
}

function isBackendPath(path) {
  return path.startsWith('backend/');
}

function setGate(result, gate, reason) {
  result.gates[gate] = true;
  if (reason && !result.reasons.includes(reason)) result.reasons.push(reason);
}

function setDomain(result, domain) {
  if (!result.domains.includes(domain)) result.domains.push(domain);
}

function addFrontendScope(result, scope) {
  if (!result.frontendScopes.includes(scope)) result.frontendScopes.push(scope);
}

function addFrontendScopeFromPath(result, path) {
  for (const [prefix, scope] of FRONTEND_SCOPE_PREFIXES) {
    if (path.startsWith(prefix)) {
      addFrontendScope(result, scope);
      return;
    }
  }
  for (const root of FRONTEND_DOMAIN_ROOTS) {
    if (path.startsWith(root)) {
      const domain = path.slice(root.length).split('/')[0];
      addFrontendScope(result, domain ? `${root.slice('frontend/'.length, -1)}/${domain}` : root.slice('frontend/'.length, -1));
      return;
    }
  }
}

function elevateRisk(result, risk) {
  if (RISK_RANK[risk] > RISK_RANK[result.risk]) result.risk = risk;
}

function markRepositoryFull(result, reason = '无法可靠分类，升级为全量相关门禁') {
  elevateRisk(result, 'full');
  result.full = true;
  for (const gate of GATE_KEYS) setGate(result, gate);
  // Focused and full Vitest jobs are mutually exclusive.
  result.gates.frontend_focus = false;
  result.frontendScopes = [...FULL_FRONTEND_SCOPES];
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
}

function markFrontendFull(result, reason = '前端公共范围变更，升级为前端全量门禁') {
  setDomain(result, 'frontend');
  elevateRisk(result, 'full');
  result.full = true;
  for (const gate of FRONTEND_FULL_GATES) setGate(result, gate);
  // Focused and full Vitest jobs are mutually exclusive.
  result.gates.frontend_focus = false;
  result.frontendScopes = [...FULL_FRONTEND_SCOPES];
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
}

function markBackendFull(result, reason = '后端公共范围变更，升级为后端全量门禁') {
  setDomain(result, 'backend-runtime');
  elevateRisk(result, 'full');
  result.full = true;
  for (const gate of BACKEND_FULL_GATES) setGate(result, gate);
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
}

function markFrontendUnit(result, path) {
  setDomain(result, 'frontend');
  elevateRisk(result, 'unit');
  setGate(result, 'frontend_focus', '前端 helper/model/API 变更运行对应业务域测试');
  setGate(result, 'frontend_typecheck');

  addFrontendScopeFromPath(result, path);
}

function markFrontendPage(result, path) {
  setDomain(result, 'frontend');
  elevateRisk(result, 'page');
  setGate(result, 'frontend_focus', '前端页面/状态变更运行对应业务域测试');
  setGate(result, 'frontend_typecheck');
  setGate(result, 'frontend_build', '页面/状态变更需要构建验证');

  addFrontendScopeFromPath(result, path);
}

function markFrontendHighRisk(result, path, reason) {
  markFrontendPage(result, path);
  elevateRisk(result, 'high');
  setGate(result, 'frontend_e2e', reason);
  setGate(result, 'frontend_release_evidence', '高风险前端变更需要发布证据检查');
}

function classifyFrontendPath(result, path) {
  if (path.startsWith('frontend/e2e/')) {
    setDomain(result, 'frontend');
    elevateRisk(result, 'high');
    setGate(result, 'frontend_e2e', 'Playwright 关键路径或测试变更');
    setGate(result, 'frontend_release_evidence', '前端关键路径变更需要发布证据检查');
    setGate(result, 'frontend_build');
    return true;
  }

  if (path.startsWith('frontend/src/styles/') || FRONTEND_HIGH_RISK_PATH.test(path)) {
    markFrontendHighRisk(result, path, '响应式、导航、移动端或全局样式变更需要 E2E');
    setGate(result, 'frontend_style');
    if (path.startsWith('frontend/src/styles/')) result.gates.frontend_focus = false;
    return true;
  }

  if (path.startsWith('frontend/src/lib/aiWorkspaceContracts.') || path.startsWith('frontend/src/components/ai/') || path.startsWith('frontend/src/api/aiApi.') || path.startsWith('frontend/src/api/aiVoiceApi.')) {
    markFrontendPage(result, path);
    setGate(result, 'frontend_ai_contract', 'AI workspace 变更需要跨端 contract 测试');
    addFrontendScopeFromPath(result, path);
    return true;
  }

  const filename = path.split('/').at(-1) ?? '';
  if (FRONTEND_UNIT_FILENAME.test(filename)) {
    markFrontendUnit(result, path);
    return true;
  }

  if (path.startsWith('frontend/src/lib/') || path.startsWith('frontend/src/hooks/') || path.startsWith('frontend/src/api/')) {
    const isPageState = FRONTEND_PAGE_FILENAME.test(filename);
    if (isPageState) markFrontendPage(result, path);
    else markFrontendUnit(result, path);
    return true;
  }

  if (path.startsWith('frontend/src/app/') || path.startsWith('frontend/src/auth/') || path.startsWith('frontend/src/components/') || path.startsWith('frontend/src/features/')) {
    if (/\.(?:test|spec)\.(?:ts|tsx|mjs)$/.test(path)) markFrontendUnit(result, path);
    else markFrontendPage(result, path);
    return true;
  }

  if (path.startsWith('frontend/scripts/')) {
    markFrontendFull(result, '前端构建、预算或门禁脚本变更');
    return true;
  }

  return false;
}

function classifyBackendPath(result, path) {
  if (path.startsWith('backend/app/ai/') || path.startsWith('backend/app/api/ai') || path.startsWith('backend/app/schemas/ai') || path.startsWith('backend/app/services/ai_') || path.startsWith('backend/tests/ai_') || path.startsWith('backend/tests/ai/')) {
    setDomain(result, 'backend-ai');
    elevateRisk(result, 'high');
    setGate(result, 'backend_ai', 'AI Runtime、Skill、Tool 或审批流变更');
    if (path.includes('/skills/') || path.includes('/evals/') || path.startsWith('backend/tests/ai_evals/')) setGate(result, 'ai_evals', 'AI Skill catalog/eval 变更');
    return true;
  }

  if (path.startsWith('backend/app/services/search/') || path.startsWith('backend/app/api/search') || path.startsWith('backend/app/repos/search') || path.startsWith('backend/app/schemas/search') || path.startsWith('backend/tests/search/')) {
    setDomain(result, 'backend-search');
    elevateRisk(result, 'high');
    setGate(result, 'backend_search', 'Search provider、索引或排序变更');
    return true;
  }

  if (path.startsWith('backend/app/services/family_model_settings/') || path.startsWith('backend/app/api/family_model_settings') || path.startsWith('backend/app/repos/family_model_settings/') || path.startsWith('backend/app/schemas/family_model_settings') || path.startsWith('backend/tests/family_model_settings/') || path.startsWith('backend/app/services/model_usage/') || path.startsWith('backend/app/api/model_usage') || path.startsWith('backend/app/repos/model_usage/') || path.startsWith('backend/app/schemas/model_usage') || path.startsWith('backend/app/models/model_usage') || path.startsWith('backend/app/models/family_model_settings') || path.startsWith('backend/tests/model_usage/')) {
    setDomain(result, 'backend-model-usage');
    elevateRisk(result, 'high');
    setGate(result, 'backend_mysql', 'Model usage/family model settings 需要 MySQL suite');
    if (path.startsWith('backend/app/models/')) setGate(result, 'backend_migration', '持久化模型变更需要 migration smoke');
    return true;
  }

  if (path.startsWith('backend/alembic/') || path.startsWith('backend/app/models/') || path.startsWith('backend/app/db/') || path.startsWith('backend/scripts/check_alembic')) {
    setDomain(result, 'backend-migration');
    elevateRisk(result, 'high');
    setGate(result, 'backend_migration', 'Migration 或持久化模型变更需要 migration smoke');
    if (path.startsWith('backend/app/models/')) setGate(result, 'backend_service', '模型变更补充普通后端服务测试');
    return true;
  }

  if (path.startsWith('backend/app/') || path.startsWith('backend/tests/')) {
    setDomain(result, 'backend-service');
    elevateRisk(result, 'page');
    setGate(result, 'backend_service', '普通后端 route/service/repo 变更');
    return true;
  }

  return false;
}

const REPOSITORY_FULL_PATTERNS = Object.freeze([
  /^\.github\//,
  /^(?:package(?:-lock)?\.json|tsconfig[^/]*|Makefile|\.nvmrc)$/,
]);

const FRONTEND_FULL_PATTERNS = Object.freeze([
  /^frontend\/(?:package(?:-lock)?\.json|vite\.config\.|tsconfig|playwright\.config\.)/,
  /^frontend\/src\/(?:App\.tsx|api\/types\.ts|api\/request\.ts|api\/client\.ts|api\/queryKeys\.ts|api\/cacheInvalidation\.ts|test\/|components\/ui-kit(?:\/|\.))/,
  /^frontend\/src\/styles\/00-ui-kit\.css$/,
]);

const BACKEND_FULL_PATTERNS = Object.freeze([
  /^backend\/(?:requirements[^/]*|pyproject\.toml|alembic\.ini|ci-test-groups\.json)$/,
  /^backend\/app\/core\/(?:security|deps|config|enums)\.py$/,
]);

const DEPENDENCY_PATTERNS = Object.freeze([
  /^(?:package(?:-lock)?\.json|frontend\/package(?:-lock)?\.json|backend\/requirements[^/]*|backend\/pyproject\.toml)$/,
]);

const DEPLOYMENT_PATTERNS = Object.freeze([
  /^deploy\//,
  /^(?:Dockerfile|\.dockerignore)/,
  /^frontend\/playwright\.deployment\.config\./,
  /^frontend\/e2e\/realtime-websocket-deployment\.spec\./,
]);

export function classifyChangedFiles(inputFiles, { eventName = 'pull_request', forceFull = false } = {}) {
  const files = [...new Set(inputFiles.map(normalizePath).filter(Boolean))].sort();
  const result = {
    changedFiles: files,
    docsOnly: false,
    full: false,
    risk: 'docs',
    domains: [],
    frontendScopes: [],
    gates: Object.fromEntries(GATE_KEYS.map((gate) => [gate, false])),
    reasons: [],
  };

  if (eventName !== 'pull_request') {
    markRepositoryFull(result, `${eventName} 不是普通 PR，执行完整门禁`);
    return result;
  }

  if (files.length === 0) {
    markRepositoryFull(result, '没有取得 PR 文件列表，按 fail-closed 处理');
    return result;
  }

  if (forceFull) {
    markRepositoryFull(result, 'PR 使用 full-gates 标记，按请求执行全量门禁');
    return result;
  }

  const nonDocumentationFiles = files.filter((file) => !isDocumentationPath(file));
  if (nonDocumentationFiles.length === 0) {
    result.docsOnly = true;
    result.risk = 'docs';
    result.reasons.push('仅文档/规则改动，不运行业务测试');
    return result;
  }

  for (const path of nonDocumentationFiles) {
    if (matchesAny(path, DEPENDENCY_PATTERNS)) {
      if (path.startsWith('frontend/')) {
        markFrontendFull(result, '前端依赖清单变更影响前端构建和运行时');
        setGate(result, 'dependency_audit', '前端依赖清单变更需要生产依赖审计');
      } else if (path.startsWith('backend/')) {
        markBackendFull(result, '后端依赖清单变更影响后端构建和运行时');
        setGate(result, 'dependency_audit', '后端依赖清单变更需要生产依赖审计');
      } else {
        markRepositoryFull(result, '根目录依赖清单变更影响整个构建和运行时');
        setGate(result, 'dependency_audit', '根目录依赖清单变更需要生产依赖审计');
      }
      continue;
    }

    if (matchesAny(path, REPOSITORY_FULL_PATTERNS)) {
      markRepositoryFull(result, '共享配置、公共契约或 CI 规则变更');
      continue;
    }

    if (matchesAny(path, FRONTEND_FULL_PATTERNS)) {
      markFrontendFull(result, '前端公共配置、契约或 UI Kit 变更');
      continue;
    }

    if (matchesAny(path, BACKEND_FULL_PATTERNS)) {
      markBackendFull(result, '后端公共配置、契约或运行时变更');
      continue;
    }

    if (matchesAny(path, DEPLOYMENT_PATTERNS)) {
      setDomain(result, 'deployment');
      elevateRisk(result, 'high');
      setGate(result, 'deployment_smokes', '部署、媒体或 WebSocket 传输变更');
      continue;
    }

    const classified = isFrontendPath(path)
      ? classifyFrontendPath(result, path)
      : isBackendPath(path)
        ? classifyBackendPath(result, path)
        : false;

    if (!classified) markRepositoryFull(result, `未知路径 ${path} 无法安全分类`);
  }

  if (result.domains.length > 1 && result.domains.includes('frontend') && result.domains.some((domain) => domain.startsWith('backend'))) {
    markRepositoryFull(result, '前后端跨域改动，升级为全量相关门禁');
  }

  if (result.domains.includes('frontend') && result.frontendScopes.length > 1) {
    markFrontendFull(result, '多个前端业务域同时变更，升级为前端全量门禁');
  }

  if (result.domains.length > 2) {
    markRepositoryFull(result, '多个业务域同时变更，升级为全量相关门禁');
  }

  return result;
}

function formatClassificationSummary(result) {
  const selectedGates = GATE_KEYS.filter((gate) => result.gates[gate]);
  const skippedGates = GATE_KEYS.filter((gate) => !result.gates[gate]);
  const visibleFiles = result.changedFiles.slice(0, 80);
  const omittedCount = result.changedFiles.length - visibleFiles.length;
  return [
    '## PR 门禁分类',
    '',
    `- 风险：**${result.risk}**`,
    `- 业务域：${result.domains.length ? result.domains.join('、') : '文档'}`,
    `- 改动文件：${result.changedFiles.length}`,
    `- 选中门禁：${selectedGates.length ? selectedGates.join('、') : '无业务门禁'}`,
    `- 跳过门禁：${skippedGates.length ? skippedGates.join('、') : '无'}`,
    '',
    '改动路径（最多展示 80 个）：',
    ...(visibleFiles.length ? visibleFiles.map((file) => `- \`${file}\``) : ['- 无']),
    ...(omittedCount > 0 ? [`- …另有 ${omittedCount} 个文件未展开`] : []),
    '',
    '分类依据：',
    ...result.reasons.map((reason) => `- ${reason}`),
  ].join('\n');
}

function parseNameStatusOutput(buffer) {
  const tokens = buffer.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (/^[RC]/.test(status)) {
      index += 1;
      if (tokens[index]) files.push(tokens[index]);
      index += 1;
      if (tokens[index]) files.push(tokens[index]);
    } else {
      index += 1;
      if (tokens[index]) files.push(tokens[index]);
    }
  }
  return files;
}

export function readChangedFilesFromGit(baseSha, headSha) {
  if (!baseSha || !headSha) throw new Error('GITHUB_BASE_SHA and GITHUB_HEAD_SHA/GITHUB_SHA are required for PR classification');
  const command = spawnSync('git', ['diff', '--name-status', '--find-renames', '--diff-filter=ACDMRTUXB', '-z', baseSha, headSha], {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 4,
  });
  if (command.error) throw command.error;
  if (command.status !== 0) throw new Error(command.stderr?.toString('utf8') || `git diff exited with ${command.status}`);
  return parseNameStatusOutput(command.stdout);
}

function parseCliFiles(argv) {
  const filesIndex = argv.indexOf('--files');
  if (filesIndex === -1) return null;
  return argv.slice(filesIndex + 1).filter((value) => value !== '--');
}

function writeGitHubOutputs(result) {
  const artifactPath = process.env.CLASSIFICATION_ARTIFACT_PATH;
  if (artifactPath) {
    const separator = artifactPath.lastIndexOf('/');
    if (separator > 0) mkdirSync(artifactPath.slice(0, separator), { recursive: true });
    writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const outputs = {
      risk: result.risk,
      docs_only: String(result.docsOnly),
      full: String(result.full),
      domains: JSON.stringify(result.domains),
      frontend_scopes: JSON.stringify(result.frontendScopes),
      classification: JSON.stringify(result),
    };
    for (const gate of GATE_KEYS) outputs[gate] = String(result.gates[gate]);
    let content = '';
    for (const [key, value] of Object.entries(outputs)) {
      if (key === 'classification') content += `${key}<<CLASSIFICATION_EOF\n${value}\nCLASSIFICATION_EOF\n`;
      else content += `${key}=${value}\n`;
    }
    appendFileSync(outputPath, content);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${formatClassificationSummary(result)}\n`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME || 'pull_request';
  const cliFiles = parseCliFiles(argv);
  const files = cliFiles ?? (eventName === 'pull_request'
    ? readChangedFilesFromGit(env.GITHUB_BASE_SHA, env.GITHUB_HEAD_SHA || env.GITHUB_SHA)
    : []);
  const result = classifyChangedFiles(files, {
    eventName,
    forceFull: env.FORCE_FULL_GATES === 'true',
  });
  writeGitHubOutputs(result);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isMain = process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
