import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = resolve(__dirname, '..');
const repoRoot = resolve(frontendRoot, '..');
const artifactDir = resolve(repoRoot, 'tmp', 'ai-skill-manual-smoke');

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8010';
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_SERVICE_TIMEOUT_MS = 60_000;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'waiting', 'waiting_input', 'waiting_approval']);
const IDLE_STABLE_MS = 1_500;

const args = parseArgs(process.argv.slice(2));
const runSuffix = args.suffix || timestampSuffix();

const names = {
  ingredient: `秋葵自动测${runSuffix}`,
  food: `盒装牛奶自动测${runSuffix}`,
  recipe: `秋葵凉拌菜自动测${runSuffix}`,
  shoppingIngredient: `秋葵自动测${runSuffix}`,
};

const coreCases = [
  {
    key: 'ingredient_create',
    skill: 'ingredient_profile',
    prompt: `帮我新增一个食材：${names.ingredient}。类型优先选择系统已有的“蔬菜”，默认单位按根，常温保存，不设置保质期；如果系统已有同名食材就更新它，不要重复创建。`,
    panelTexts: [names.ingredient],
  },
  {
    key: 'ingredient_update',
    skill: 'ingredient_profile',
    prompt: `把${names.ingredient}的默认保存位置改成冷藏，备注写成焯水后更适合凉拌。`,
    panelTexts: [names.ingredient, '冷藏'],
  },
  {
    key: 'inventory_restock',
    skill: 'inventory_analysis',
    prompt: `把今天买的${names.ingredient} 3 根录入库存，状态新鲜，放冷藏。这个食材应该优先使用已有的${names.ingredient}档案。`,
    panelTexts: [names.ingredient],
  },
  {
    key: 'inventory_consume',
    skill: 'inventory_analysis',
    prompt: `今天用了 1 根${names.ingredient}，请从库存里扣减。`,
    panelTexts: [names.ingredient],
  },
  {
    key: 'food_create',
    skill: 'food_profile',
    prompt: `新增一个食物资料：${names.food}，类型从已有选项里选“即食”，适合早餐；如果同名食物已存在就更新它，不要重复创建。`,
    panelTexts: [names.food],
  },
  {
    key: 'food_favorite',
    skill: 'food_profile',
    prompt: `把${names.food}加入常用收藏。`,
    panelTexts: [names.food],
  },
  {
    key: 'recipe_create',
    skill: 'recipe_draft',
    prompt: `帮我新增一道${names.recipe}的菜谱，2 人份，难度从已有选项里选“简单”。食材只使用已有的${names.ingredient} 2 根，不要临时编造食材 ID；步骤写清楚焯水、沥干和调味。`,
    panelTexts: [names.recipe],
  },
  {
    key: 'recipe_update',
    skill: 'recipe_draft',
    prompt: `把${names.recipe}改成 3 人份，步骤里补充“拌好后静置 5 分钟再装盘”。`,
    panelTexts: [names.recipe, '3'],
  },
  {
    key: 'meal_plan_create',
    skill: 'meal_plan',
    prompt: `把明天晚餐追加安排成${names.food}；如果明天晚餐已有其他计划，也保留现有计划并追加为新的计划，不要替换任何已有计划。`,
    panelTexts: [names.food],
  },
  {
    key: 'meal_plan_update',
    skill: 'meal_plan',
    prompt: `把明天晚餐里${names.food}的备注改成“自动测试少糖”，不要换成不存在的食物。`,
    panelTexts: [names.food, '少糖'],
  },
  {
    key: 'shopping_create',
    skill: 'shopping_list',
    prompt: `把${names.shoppingIngredient}加入购物清单，数量 2 根，原因是自动测试采购。`,
    panelTexts: [names.shoppingIngredient],
  },
  {
    key: 'shopping_done',
    skill: 'shopping_list',
    prompt: `把购物清单里的${names.shoppingIngredient}标记为已买。`,
    panelTexts: [names.shoppingIngredient],
  },
  {
    key: 'meal_log_create',
    skill: 'meal_log',
    prompt: `记录今晚吃了${names.food}，1 份，心情不错。`,
    panelTexts: [names.food],
  },
  {
    key: 'meal_log_rate',
    skill: 'meal_log',
    prompt: `给刚才那顿${names.food}打 4.5 分。`,
    panelTexts: ['4.5'],
  },
  {
    key: 'recipe_cook',
    skill: 'recipe_cook',
    prompt: `预览开始做${names.recipe}，按 1 人份；如果库存足够，请生成做菜确认并在完成后记录到今晚晚餐，如果库存不足就说明缺什么。`,
    panelTexts: [names.recipe],
    allowHumanInput: true,
    allowNoApprovalTexts: ['库存不足', '缺少', '补库存', '调整份量'],
  },
];

const destructiveCases = [
  {
    key: 'recipe_delete',
    skill: 'recipe_draft',
    prompt: `删除${names.recipe}这道菜谱。`,
    panelTexts: [names.recipe, '删除'],
  },
];

const diagnosticCases = [
  {
    key: 'diagnostics',
    skill: 'workspace_diagnostics',
  },
];

function parseArgs(argv) {
  const result = {
    backendUrl: process.env.CULINA_BACKEND_URL || DEFAULT_BACKEND_URL,
    frontendUrl: process.env.CULINA_FRONTEND_URL || '',
    username: process.env.CULINA_TEST_USERNAME || '',
    password: process.env.CULINA_TEST_PASSWORD || '',
    token: process.env.CULINA_ACCESS_TOKEN || '',
    decision: process.env.CULINA_AI_SKILL_DECISION || 'approve',
    headed: process.env.CULINA_HEADED === '1',
    includeDestructive: false,
    startBackend: process.env.CULINA_START_BACKEND !== '0',
    cases: 'core',
    suffix: process.env.CULINA_TEST_SUFFIX || '',
    slowMo: Number(process.env.CULINA_PLAYWRIGHT_SLOW_MO || 0),
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--headed') {
      result.headed = true;
    } else if (arg === '--no-start-backend') {
      result.startBackend = false;
    } else if (arg === '--include-destructive') {
      result.includeDestructive = true;
    } else if (arg.startsWith('--url=')) {
      result.frontendUrl = valueAfterEquals(arg);
    } else if (arg.startsWith('--backend=')) {
      result.backendUrl = valueAfterEquals(arg);
    } else if (arg.startsWith('--username=')) {
      result.username = valueAfterEquals(arg);
    } else if (arg.startsWith('--password=')) {
      result.password = valueAfterEquals(arg);
    } else if (arg.startsWith('--token=')) {
      result.token = valueAfterEquals(arg);
    } else if (arg.startsWith('--decision=')) {
      result.decision = valueAfterEquals(arg);
    } else if (arg.startsWith('--cases=')) {
      result.cases = valueAfterEquals(arg);
    } else if (arg.startsWith('--suffix=')) {
      result.suffix = valueAfterEquals(arg);
    } else if (arg.startsWith('--slow-mo=')) {
      result.slowMo = Number(valueAfterEquals(arg));
    } else {
      throw new Error(`未知参数：${arg}。运行 --help 查看用法。`);
    }
  }

  if (!['approve', 'reject', 'none'].includes(result.decision)) {
    throw new Error('--decision 只能是 approve、reject 或 none。');
  }
  if (result.slowMo < 0 || Number.isNaN(result.slowMo)) {
    throw new Error('--slow-mo 必须是非负数字。');
  }
  return result;
}

function valueAfterEquals(arg) {
  return arg.slice(arg.indexOf('=') + 1).trim();
}

function printHelp() {
  console.log(`AI Skill 手动冒烟脚本

用法：
  npm --prefix frontend run ai:skill-smoke -- --username=<user> --password=<password>
  npm --prefix frontend run ai:skill-smoke -- --token=<access-token>

常用参数：
  --url=http://127.0.0.1:5173          使用已启动的前端，不自动启动 Vite dev server
  --backend=http://127.0.0.1:8010      后端地址；默认不可达时会自动运行 npm run backend:dev
  --no-start-backend                   后端不可达时直接失败，不自动启动
  --decision=approve|reject|none       审批动作，默认 approve，会修改测试家庭数据
  --cases=core|destructive|diagnostics|all|a,b  运行用例集合或逗号分隔 key，默认 core
  --include-destructive                在 core 后追加删除类用例
  --suffix=ABC                         测试对象名称后缀，默认按时间生成
  --headed                             有界面运行
  --slow-mo=250                        每步操作延迟，方便观察

前置条件：
  1. 本地数据库和 MinIO 已启动；可先运行 npm run db:up。
  2. AI provider 可用。
  3. 使用专门测试家庭；approve 模式会真实写入业务数据。

报告：
  每次运行都会写入 tmp/ai-skill-manual-smoke/report-*.json 和 report-*.md。`);
}

function timestampSuffix() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function selectedCases() {
  if (args.cases === 'core') {
    return args.includeDestructive ? [...coreCases, ...destructiveCases] : coreCases;
  }
  if (args.cases === 'destructive') return destructiveCases;
  if (args.cases === 'diagnostics') return diagnosticCases;
  if (args.cases === 'all') return [...coreCases, ...destructiveCases];
  const byKey = new Map([...coreCases, ...destructiveCases, ...diagnosticCases].map((testCase) => [testCase.key, testCase]));
  return args.cases.split(',').map((key) => {
    const testCase = byKey.get(key.trim());
    if (!testCase) {
      throw new Error(`未知用例 key：${key}`);
    }
    return testCase;
  });
}

async function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('无法获取可用端口。'));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHttp(url, child, timeoutMs = 30_000, label = '服务') {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label}提前退出，exit code: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`等待${label}超时：${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function startBackendServer() {
  const healthUrl = `${trimTrailingSlash(args.backendUrl)}/api/health`;
  if (await isHttpOk(healthUrl)) {
    return { started: false, output: '', stop: async () => undefined };
  }
  if (!args.startBackend) {
    throw new Error(`后端不可达：${healthUrl}。已使用 --no-start-backend，不会自动启动。`);
  }
  if (!existsSync(resolve(repoRoot, 'backend', '.venv'))) {
    throw new Error('backend/.venv 不存在。请先运行 npm run backend:venv。');
  }
  const child = spawn('npm', ['run', 'backend:dev'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let output = '';
  const collect = (chunk) => {
    output = trimOutputTail(`${output}${chunk.toString()}`);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  try {
    await waitForHttp(healthUrl, child, DEFAULT_SERVICE_TIMEOUT_MS, '后端服务');
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- backend output ---\n${output}`);
  }
  return {
    started: true,
    get output() {
      return output;
    },
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await delay(500);
    },
  };
}

async function isHttpOk(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function startDevServer() {
  if (!existsSync(resolve(frontendRoot, 'node_modules'))) {
    throw new Error('frontend/node_modules 不存在。请先运行 npm run frontend:install。');
  }
  const port = await findOpenPort();
  const child = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--force'],
    {
      cwd: frontendRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', VITE_API_BASE_URL: args.backendUrl },
    }
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(url, child, 30_000, '前端服务');
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
  return {
    url,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await delay(250);
    },
  };
}

async function login(page) {
  if (args.token) {
    await page.goto(frontendUrl(), { waitUntil: 'domcontentloaded' });
    return;
  }
  if (!args.username || !args.password) {
    throw new Error('请通过 --username/--password 或 --token 提供登录信息。');
  }
  await page.goto(frontendUrl(), { waitUntil: 'domcontentloaded' });
  const loginHeading = page.getByRole('heading', { name: '登录家庭厨房' });
  if (await loginHeading.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.getByLabel('用户名').fill(args.username);
    await page.getByLabel('密码').fill(args.password);
    await page.getByRole('button', { name: '进入家庭厨房' }).click();
  }
  await page.waitForFunction(() => Boolean(localStorage.getItem('culina-access-token')), undefined, { timeout: 20_000 });
}

let resolvedFrontendUrl = '';
function frontendUrl() {
  return resolvedFrontendUrl;
}

async function openAiWorkspace(page) {
  const status = await fetchAiStatus(page, args.backendUrl);
  if (!status?.enabled) {
    throw new Error(`AI 未就绪：${status ? `${status.status}，${status.detail}` : '无法读取 /api/ai/status'}`);
  }
  await page.getByRole('button', { name: 'AI' }).first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: 'AI' }).first().click();
  await expectVisibleText(page, 'AI 厨房助手', 'AI 工作台');
  const unavailable = await page.getByText('AI 未配置').isVisible({ timeout: 2_000 }).catch(() => false);
  if (unavailable) {
    throw new Error('AI 未配置，无法执行 skill 手动冒烟。');
  }
  const newChatButton = page.getByRole('button', { name: /新会话/ }).first();
  if (await newChatButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await newChatButton.click();
  }
  await waitForComposerReady(page);
}

async function runCase(page, testCase) {
  const startedAt = new Date();
  console.log(`\n[${testCase.key}] ${testCase.skill}`);
  console.log(`prompt: ${testCase.prompt}`);
  await waitForComposerReady(page);
  const panelCountBefore = await page.locator('.ai-approval-panel').count();
  const textarea = page.locator('.ai-composer textarea').last();
  await textarea.fill(testCase.prompt);
  const sendButton = page.getByRole('button', { name: '发送消息' });
  await sendButton.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return Boolean(button && !button.disabled);
  }, undefined, { timeout: 10_000 });
  await sendButton.click();

  const waitResult = await waitForApprovalOrAllowedNoApproval(page, panelCountBefore, testCase);
  if (waitResult.type === 'allowed-no-approval') {
    console.log(`[${testCase.key}] no approval: matched allowed non-approval text`);
    return caseResult(testCase, startedAt, 'no-approval-allowed', {
      matchedText: waitResult.matchedText,
      conversation: await latestConversationRunState(page, args.backendUrl),
    });
  }
  if (waitResult.type === 'human-input') {
    console.log(`[${testCase.key}] human input required: allowed by case`);
    return caseResult(testCase, startedAt, 'human-input-required', {
      panelText: await panelContent(waitResult.panel),
      conversation: await latestConversationRunState(page, args.backendUrl),
    });
  }

  const panel = waitResult.panel;
  const text = await panelContent(panel);
  const approvalMeta = await approvalPanelMeta(panel);
  for (const expected of testCase.panelTexts ?? []) {
    if (!text.includes(expected)) {
      throw new Error(`[${testCase.key}] 审批面板缺少预期文本：${expected}\n--- panel ---\n${text}`);
    }
  }

  if (args.decision === 'none') {
    console.log(`[${testCase.key}] approval pending; --decision=none，脚本停止在当前页面。`);
    return caseResult(testCase, startedAt, 'pending', { approval: approvalMeta, panelText: text });
  }

  const decision = args.decision === 'approve' ? 'approved' : 'rejected';
  await waitForApprovalReady(page, testCase.key);
  await submitDecision(panel, decision);
  await waitForDecisionStatus(page, decision);
  await waitForLatestConversationIdle(page, testCase.key);
  await waitForComposerReady(page);
  console.log(`[${testCase.key}] ${decision}`);
  return caseResult(testCase, startedAt, decision, {
    approval: approvalMeta,
    conversation: await latestConversationRunState(page, args.backendUrl),
  });
}

function caseResult(testCase, startedAt, status, extra = {}) {
  const finishedAt = new Date();
  return {
    key: testCase.key,
    skill: testCase.skill,
    status,
    prompt: testCase.prompt,
    expectedPanelTexts: testCase.panelTexts ?? [],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...extra,
  };
}

async function panelContent(panel) {
  return panel.evaluate((element) => {
    const inputValues = Array.from(element.querySelectorAll('input, textarea, select'))
      .map((field) => {
        if (field instanceof HTMLSelectElement) {
          return field.selectedOptions.length > 0
            ? Array.from(field.selectedOptions).map((option) => option.textContent || option.value).join(' ')
            : field.value;
        }
        return field.value;
      })
      .filter(Boolean);
    return [element.textContent || '', ...inputValues].join('\n');
  });
}

async function approvalPanelMeta(panel) {
  return panel.evaluate((element) => {
    const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title =
      element.querySelector('.ai-approval-title-row')?.textContent?.replace(/\s+/g, ' ').trim() ||
      element.querySelector('.ai-approval-head-copy')?.textContent?.replace(/\s+/g, ' ').trim() ||
      '';
    const status =
      element.querySelector('.ai-approval-status')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return {
      title,
      status,
      summary: text.slice(0, 500),
    };
  });
}

async function runDiagnostics(page) {
  console.log('\n[diagnostics] AI 质量诊断弹窗');
  await page.locator('.ai-quality-trigger').click();
  await expectVisibleText(page, 'AI 质量诊断', 'AI 质量诊断弹窗');
  await expectAnyVisibleText(page, ['常用 Skill', '暂时读不到指标', '发起一次 AI 任务后'], 'AI 质量诊断内容');
  const closeButton = page.getByRole('button', { name: /关闭 AI 质量诊断|关闭/ }).first();
  if (await closeButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeButton.click();
  } else {
    await page.keyboard.press('Escape');
  }
  return {
    key: 'diagnostics',
    skill: 'workspace_diagnostics',
    status: 'checked',
    prompt: '',
    durationMs: 0,
  };
}

async function waitForApprovalOrAllowedNoApproval(page, panelCountBefore, testCase) {
  const startedAt = Date.now();
  const humanInputCountBefore = await page.locator('.ai-human-input-request').count();
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const failureText = await latestExecutionFailureText(page);
    if (failureText) {
      throw new Error(`[${testCase.key}] AI 执行失败：${failureText}`);
    }
    if (testCase.allowHumanInput) {
      const humanInputPanels = page.locator('.ai-human-input-request');
      const humanInputCount = await humanInputPanels.count();
      if (humanInputCount > humanInputCountBefore) {
        const panel = humanInputPanels.nth(humanInputCount - 1);
        await panel.waitFor({ state: 'visible', timeout: 10_000 });
        return { type: 'human-input', panel };
      }
    }
    const panels = page.locator('.ai-approval-panel');
    const panelCount = await panels.count();
    if (panelCount > panelCountBefore) {
      const panel = panels.nth(panelCount - 1);
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      return { type: 'approval', panel };
    }
    if (testCase.allowNoApprovalTexts?.length) {
      const state = await latestConversationRunState(page, args.backendUrl).catch(() => null);
      if (state && !state.active && state.status !== 'empty' && Date.now() - startedAt > 2_000) {
        const assistantText = await latestAssistantText(page);
        const matchedText = testCase.allowNoApprovalTexts.find((text) => assistantText.includes(text));
        if (matchedText) {
          return { type: 'allowed-no-approval', matchedText };
        }
        throw new Error(
          `[${testCase.key}] AI 已结束但没有出现审批面板，也没有匹配允许的无审批文本。\n--- latest assistant ---\n${assistantText.slice(-2_000)}`
        );
      }
    }
    await delay(500);
  }
  throw new Error(`[${testCase.key}] 等待审批面板超时。`);
}

async function latestExecutionFailureText(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('.ai-message, .ai-message-bubble, .ai-execution-card'));
    for (const element of candidates.reverse()) {
      const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (text.includes('执行失败')) return text;
    }
    return '';
  }).catch(() => '');
}

async function latestAssistantText(page) {
  return page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll('.ai-message-assistant'));
    const latest = messages.at(-1);
    return latest?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }).catch(() => '');
}

async function fetchAiStatus(page, backendUrl) {
  return page.evaluate(async (url) => {
    const token = localStorage.getItem('culina-access-token');
    if (!token) return null;
    const response = await fetch(`${url.replace(/\/$/, '')}/api/ai/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return response.json();
  }, backendUrl).catch(() => null);
}

async function fetchAiRegistry(page, backendUrl) {
  return page.evaluate(async (url) => {
    const token = localStorage.getItem('culina-access-token');
    if (!token) return null;
    const response = await fetch(`${url.replace(/\/$/, '')}/api/ai/registry`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return response.json();
  }, backendUrl).catch(() => null);
}

async function submitDecision(panel, decision) {
  const selector =
    decision === 'approved'
      ? '.ai-approval-actions .solid-button'
      : '.ai-approval-actions .ghost-button';
  const button = panel.locator(selector).last();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
}

async function waitForDecisionStatus(page, decision) {
  const expectedText = decision === 'approved' ? '已确认' : '已拒绝';
  await page
    .waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll('.ai-approval-panel')).some((panel) =>
          (panel.textContent ?? '').includes(text)
        ),
      expectedText,
      { timeout: DEFAULT_TIMEOUT_MS }
    )
    .catch((error) => {
      throw new Error(`等待审批状态 ${expectedText} 超时：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function waitForComposerReady(page) {
  await page
    .waitForFunction(
      () => {
        const textarea = document.querySelector('.ai-composer textarea');
        const stopButton = document.querySelector('button[aria-label="中止生成"]');
        return Boolean(textarea && !textarea.disabled && !stopButton);
      },
      undefined,
      { timeout: DEFAULT_TIMEOUT_MS }
    )
    .catch((error) => {
      throw new Error(`等待 AI 输入框可用超时：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function waitForApprovalReady(page, label) {
  const startedAt = Date.now();
  let lastState = 'no conversation';
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const state = await latestConversationRunState(page, args.backendUrl);
    lastState = state.description;
    if (state.status === 'waiting_approval') return;
    if (!state.active && state.status !== 'empty') return;
    await delay(500);
  }
  throw new Error(`[${label}] 等待审批可确认超时：${lastState}`);
}

async function waitForLatestConversationIdle(page, label) {
  const startedAt = Date.now();
  let idleSince = 0;
  let lastState = 'no conversation';
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const state = await latestConversationRunState(page, args.backendUrl);
    lastState = state.description;
    if (!state.active) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= IDLE_STABLE_MS) return;
    } else {
      idleSince = 0;
    }
    await delay(500);
  }
  throw new Error(`[${label}] 等待会话空闲超时：${lastState}`);
}

async function latestConversationRunState(page, backendUrl) {
  return page.evaluate(async ({ url, activeStatuses }) => {
    const token = localStorage.getItem('culina-access-token');
    if (!token) {
      return { active: false, description: 'missing token' };
    }
    const response = await fetch(`${url.replace(/\/$/, '')}/api/ai/conversations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return { active: true, description: `conversation fetch ${response.status}` };
    }
    const conversations = await response.json();
    if (!Array.isArray(conversations) || conversations.length === 0) {
      return { active: false, description: 'no conversation' };
    }
    const latest = [...conversations].sort((left, right) => {
      const leftTime = Date.parse(left.last_message_at || left.created_at || '') || 0;
      const rightTime = Date.parse(right.last_message_at || right.created_at || '') || 0;
      return rightTime - leftTime;
    })[0];
    const status = String(latest.last_run_status || '').toLowerCase();
    return {
      active: activeStatuses.includes(status),
      status: status || 'empty',
      id: latest.id || '',
      title: latest.title || latest.prompt || '',
      lastMessageAt: latest.last_message_at || '',
      description: `${latest.id || 'unknown'} last_run_status=${status || 'empty'}`,
    };
  }, { url: backendUrl, activeStatuses: Array.from(ACTIVE_RUN_STATUSES) });
}

async function collectFailureDiagnostics(page, testCase, error, pageErrors, consoleErrors) {
  mkdirSync(artifactDir, { recursive: true });
  const key = testCase?.key || 'setup';
  const screenshotPath = resolve(artifactDir, `failure-${Date.now()}-${key}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const latestPanelText = await page.locator('.ai-approval-panel').last().evaluate((element) => element.textContent ?? '').catch(() => '');
  const latestHumanInputText = await page.locator('.ai-human-input-request').last().evaluate((element) => element.textContent ?? '').catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return {
    key,
    error: error instanceof Error ? error.message : String(error),
    screenshotPath,
    pageErrors: [...pageErrors],
    consoleErrors: [...consoleErrors],
    latestExecutionFailureText: await latestExecutionFailureText(page),
    latestConversation: await latestConversationRunState(page, args.backendUrl).catch((reason) => ({
      active: false,
      description: reason instanceof Error ? reason.message : String(reason),
    })),
    latestPanelText: latestPanelText.slice(0, 4_000),
    latestHumanInputText: latestHumanInputText.slice(0, 2_000),
    bodyTextTail: bodyText.slice(-5_000),
  };
}

async function expectVisibleText(page, text, label) {
  await page
    .waitForFunction(
      (expectedText) =>
        Array.from(document.querySelectorAll('body *')).some((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            (element.textContent ?? '').includes(expectedText)
          );
        }),
      text,
      { timeout: 20_000 }
    )
    .catch((error) => {
      throw new Error(`${label} 未渲染：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function expectAnyVisibleText(page, texts, label) {
  await page
    .waitForFunction(
      (expectedTexts) =>
        Array.from(document.querySelectorAll('body *')).some((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const text = element.textContent ?? '';
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            expectedTexts.some((expectedText) => text.includes(expectedText))
          );
        }),
      texts,
      { timeout: 20_000 }
    )
    .catch((error) => {
      throw new Error(`${label} 未渲染：${error instanceof Error ? error.message : String(error)}`);
    });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, '');
}

function trimOutputTail(value) {
  return value.length > 12_000 ? value.slice(-12_000) : value;
}

function createRunReport(tests) {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    status: 'running',
    suffix: runSuffix,
    frontendUrl: '',
    backendUrl: args.backendUrl,
    decision: args.decision,
    casesRequested: tests.map((testCase) => testCase.key),
    cases: [],
    diagnostics: {},
    failures: [],
    runtimeErrors: {
      pageErrors: [],
      consoleErrors: [],
    },
    artifacts: {},
  };
}

function writeReport(report) {
  mkdirSync(artifactDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const jsonPath = resolve(artifactDir, `report-${stamp}.json`);
  const markdownPath = resolve(artifactDir, `report-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdownReport(report));
  return { jsonPath, markdownPath };
}

function renderMarkdownReport(report) {
  const lines = [
    '# AI Skill Manual Smoke Report',
    '',
    `- status: ${report.status}`,
    `- startedAt: ${report.startedAt}`,
    `- finishedAt: ${report.finishedAt || ''}`,
    `- frontendUrl: ${report.frontendUrl}`,
    `- backendUrl: ${report.backendUrl}`,
    `- decision: ${report.decision}`,
    `- suffix: ${report.suffix}`,
    '',
    '## Cases',
    '',
    '| case | skill | status | durationMs | note |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const item of report.cases) {
    lines.push(`| ${item.key} | ${item.skill || ''} | ${item.status} | ${item.durationMs ?? ''} | ${escapeMarkdownTable(item.approval?.title || item.matchedText || '')} |`);
  }
  if (report.failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const failure of report.failures) {
      lines.push(`### ${failure.key}`, '');
      lines.push(`- error: ${escapeMarkdownInline(failure.error)}`);
      lines.push(`- screenshot: ${failure.screenshotPath}`);
      lines.push(`- latestConversation: ${escapeMarkdownInline(failure.latestConversation?.description || '')}`);
      if (failure.latestExecutionFailureText) {
        lines.push(`- latestExecutionFailureText: ${escapeMarkdownInline(failure.latestExecutionFailureText)}`);
      }
      lines.push('');
    }
  }
  if (report.runtimeErrors.pageErrors.length || report.runtimeErrors.consoleErrors.length) {
    lines.push('## Runtime Errors', '');
    for (const error of report.runtimeErrors.pageErrors) lines.push(`- page: ${escapeMarkdownInline(error)}`);
    for (const error of report.runtimeErrors.consoleErrors) lines.push(`- console: ${escapeMarkdownInline(error)}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);
}

function escapeMarkdownInline(value) {
  return String(value).replace(/\n/g, ' ').slice(0, 500);
}

async function main() {
  const tests = selectedCases();
  const report = createRunReport(tests);
  if (tests.length === 0) {
    throw new Error('没有可执行用例。');
  }
  if (args.decision === 'approve') {
    console.log('注意：当前为 approve 模式，会真实修改测试家庭数据。');
  }
  console.log(`测试对象后缀：${runSuffix}`);

  let backendServer;
  let devServer;
  let browser;
  let context;
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  let currentCase = null;
  try {
    backendServer = await startBackendServer();
    if (backendServer.started) {
      console.log('后端服务：已自动启动 npm run backend:dev');
    } else {
      console.log('后端服务：复用已运行实例');
    }
    devServer = args.frontendUrl ? null : await startDevServer();
  resolvedFrontendUrl = args.frontendUrl || devServer.url;
    report.frontendUrl = resolvedFrontendUrl;
  console.log(`前端地址：${resolvedFrontendUrl}`);
  console.log(`后端地址：${args.backendUrl}`);

    browser = await chromium.launch({ headless: !args.headed, slowMo: args.slowMo });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  context.on('page', (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
  });
  if (args.token) {
    await context.addInitScript((token) => {
      localStorage.setItem('culina-access-token', token);
      localStorage.setItem('culina-active-tab-v4', 'home');
    }, args.token);
  }
    page = await context.newPage();

    await login(page);
    report.diagnostics.aiStatus = await fetchAiStatus(page, args.backendUrl);
    report.diagnostics.aiRegistry = await fetchAiRegistry(page, args.backendUrl);
    await openAiWorkspace(page);
    for (const testCase of tests) {
      currentCase = testCase;
      if (testCase.key === 'diagnostics') {
        report.cases.push(await runDiagnostics(page));
        continue;
      }
      const result = await runCase(page, testCase);
      report.cases.push(result);
      if (result.status === 'pending') break;
    }
    if ((args.cases === 'core' || args.cases === 'all') && !report.cases.some((item) => item.key === 'diagnostics')) {
      currentCase = { key: 'diagnostics', skill: 'workspace_diagnostics' };
      report.cases.push(await runDiagnostics(page));
    }
    assertNoRuntimeErrors(pageErrors, consoleErrors);
    report.status = 'passed';
    console.log('\nAI skill manual smoke passed.');
    console.table(report.cases.map(({ key, skill, status, durationMs }) => ({ key, skill, status, durationMs })));
  } catch (error) {
    report.status = 'failed';
    if (page) {
      const failure = await collectFailureDiagnostics(page, currentCase, error, pageErrors, consoleErrors);
      report.failures.push(failure);
      console.error(`\n失败截图：${failure.screenshotPath}`);
    }
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.runtimeErrors.pageErrors = [...pageErrors];
    report.runtimeErrors.consoleErrors = [...consoleErrors];
    if (backendServer?.started) {
      report.diagnostics.backendOutputTail = backendServer.output;
    }
    const paths = writeReport(report);
    console.log(`报告 JSON：${paths.jsonPath}`);
    console.log(`报告 Markdown：${paths.markdownPath}`);
    await context?.close();
    await browser?.close();
    await devServer?.stop();
    await backendServer?.stop();
  }
}

function assertNoRuntimeErrors(pageErrors, consoleErrors) {
  if (pageErrors.length > 0) {
    throw new Error(`页面运行错误：\n${pageErrors.join('\n')}`);
  }
  const relevantConsoleErrors = consoleErrors.filter(
    (message) =>
      !message.includes('Failed to load resource') &&
      !message.includes('favicon') &&
      !message.includes('net::ERR_ABORTED')
  );
  if (relevantConsoleErrors.length > 0) {
    throw new Error(`浏览器 console error：\n${relevantConsoleErrors.join('\n')}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
