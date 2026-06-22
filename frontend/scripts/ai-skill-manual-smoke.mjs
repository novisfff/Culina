import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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

const args = parseArgs(process.argv.slice(2));
const runSuffix = args.suffix || timestampSuffix();

const names = {
  ingredient: `秋葵自动测${runSuffix}`,
  food: `盒装牛奶自动测${runSuffix}`,
  recipe: `番茄鸡蛋面自动测${runSuffix}`,
  shoppingIngredient: `秋葵自动测${runSuffix}`,
};

const coreCases = [
  {
    key: 'ingredient_create',
    skill: 'ingredient_profile',
    prompt: `帮我新增一个食材：${names.ingredient}，默认单位按根，常温保存，不设置保质期。`,
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
    prompt: '把今天买的番茄 2 个录入库存，放冷藏。',
    panelTexts: ['番茄'],
  },
  {
    key: 'inventory_consume',
    skill: 'inventory_analysis',
    prompt: '今天用了 1 个番茄。',
    panelTexts: ['番茄'],
  },
  {
    key: 'food_create',
    skill: 'food_profile',
    prompt: `新增一个食物资料：${names.food}，类型是即食，适合早餐。`,
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
    prompt: `帮我新增一道${names.recipe}的菜谱，2 人份，做法简单一点。`,
    panelTexts: [names.recipe],
  },
  {
    key: 'recipe_update',
    skill: 'recipe_draft',
    prompt: `把${names.recipe}改成 3 人份，步骤里提醒先炒番茄出汁。`,
    panelTexts: [names.recipe, '3'],
  },
  {
    key: 'meal_plan_create',
    skill: 'meal_plan',
    prompt: `把明天晚餐安排成${names.food}。`,
    panelTexts: [names.food],
  },
  {
    key: 'meal_plan_update',
    skill: 'meal_plan',
    prompt: `把明天晚餐里的${names.food}改成${names.recipe}。`,
    panelTexts: [names.recipe],
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
    prompt: '记录今晚吃了番茄炒蛋，1 份，心情不错。',
    panelTexts: ['番茄炒蛋'],
  },
  {
    key: 'meal_log_rate',
    skill: 'meal_log',
    prompt: '给刚才那顿番茄炒蛋打 4.5 分。',
    panelTexts: ['4.5'],
  },
  {
    key: 'recipe_cook',
    skill: 'recipe_cook',
    prompt: '开始做番茄炒蛋，按 2 人份，做完后记录到今晚晚餐。',
    panelTexts: ['番茄炒蛋'],
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
  --backend=http://127.0.0.1:8010      自动启动前端时注入的后端地址
  --decision=approve|reject|none       审批动作，默认 approve，会修改测试家庭数据
  --cases=core|destructive|all|a,b     运行用例集合或逗号分隔 key，默认 core
  --include-destructive                在 core 后追加删除类用例
  --suffix=ABC                         测试对象名称后缀，默认按时间生成
  --headed                             有界面运行
  --slow-mo=250                        每步操作延迟，方便观察

前置条件：
  1. 后端已启动，且 AI provider 可用。
  2. 测试家庭已准备 docs/ai-skill-manual-test-guide.md 中的数据。
  3. 使用专门测试家庭；approve 模式会真实写入业务数据。`);
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
  if (args.cases === 'all') return [...coreCases, ...destructiveCases];
  const byKey = new Map([...coreCases, ...destructiveCases].map((testCase) => [testCase.key, testCase]));
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

async function waitForHttp(url, child) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < 30_000) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`前端服务提前退出，exit code: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`等待前端服务超时：${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function startDevServer() {
  if (!existsSync(resolve(frontendRoot, 'node_modules'))) {
    throw new Error('frontend/node_modules 不存在。请先运行 npm run frontend:install。');
  }
  const port = await findOpenPort();
  const child = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
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
    await waitForHttp(url, child);
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
}

let resolvedFrontendUrl = '';
function frontendUrl() {
  return resolvedFrontendUrl;
}

async function openAiWorkspace(page) {
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
    return { key: testCase.key, status: 'no-approval-allowed' };
  }
  if (waitResult.type === 'human-input') {
    console.log(`[${testCase.key}] human input required: allowed by case`);
    return { key: testCase.key, status: 'human-input-required' };
  }

  const panel = waitResult.panel;
  const text = await panelContent(panel);
  for (const expected of testCase.panelTexts ?? []) {
    if (!text.includes(expected)) {
      throw new Error(`[${testCase.key}] 审批面板缺少预期文本：${expected}\n--- panel ---\n${text}`);
    }
  }

  if (args.decision === 'none') {
    console.log(`[${testCase.key}] approval pending; --decision=none，脚本停止在当前页面。`);
    return { key: testCase.key, status: 'pending' };
  }

  const decision = args.decision === 'approve' ? 'approved' : 'rejected';
  await submitDecision(panel, decision);
  await waitForDecisionStatus(page, decision);
  await waitForComposerReady(page);
  console.log(`[${testCase.key}] ${decision}`);
  return { key: testCase.key, status: decision };
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

async function runDiagnostics(page) {
  console.log('\n[diagnostics] AI 质量诊断弹窗');
  await page.locator('.ai-quality-trigger').click();
  await expectVisibleText(page, 'AI 质量诊断', 'AI 质量诊断弹窗');
  await expectVisibleText(page, 'Skill', 'AI 质量诊断内容');
  const closeButton = page.getByRole('button', { name: /关闭 AI 质量诊断|关闭/ }).first();
  if (await closeButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeButton.click();
  } else {
    await page.keyboard.press('Escape');
  }
  return { key: 'diagnostics', status: 'checked' };
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
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (testCase.allowNoApprovalTexts.some((text) => bodyText.includes(text))) {
        return { type: 'allowed-no-approval' };
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main() {
  const tests = selectedCases();
  if (tests.length === 0) {
    throw new Error('没有可执行用例。');
  }
  if (args.decision === 'approve') {
    console.log('注意：当前为 approve 模式，会真实修改测试家庭数据。');
  }
  console.log(`测试对象后缀：${runSuffix}`);

  const devServer = args.frontendUrl ? null : await startDevServer();
  resolvedFrontendUrl = args.frontendUrl || devServer.url;
  console.log(`前端地址：${resolvedFrontendUrl}`);
  console.log(`后端地址：${args.backendUrl}`);

  const browser = await chromium.launch({ headless: !args.headed, slowMo: args.slowMo });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  const consoleErrors = [];
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
  const page = await context.newPage();

  const results = [];
  try {
    await login(page);
    await openAiWorkspace(page);
    for (const testCase of tests) {
      const result = await runCase(page, testCase);
      results.push(result);
      if (result.status === 'pending') break;
    }
    if (args.cases === 'core' || args.cases === 'all') {
      results.push(await runDiagnostics(page));
    }
    assertNoRuntimeErrors(pageErrors, consoleErrors);
    console.log('\nAI skill manual smoke passed.');
    console.table(results);
  } catch (error) {
    mkdirSync(artifactDir, { recursive: true });
    const screenshotPath = resolve(artifactDir, `failure-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    console.error(`\n失败截图：${screenshotPath}`);
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await devServer?.stop();
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
