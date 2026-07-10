import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chooseHumanInputOption } from './ai-skill-smoke-human-input.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = resolve(__dirname, '..');
const repoRoot = resolve(frontendRoot, '..');
const artifactDir = resolve(repoRoot, 'tmp', 'ai-skill-manual-smoke');

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8010';
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_SERVICE_TIMEOUT_MS = 60_000;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'waiting', 'waiting_input', 'waiting_approval']);
const IDLE_STABLE_MS = 1_500;
const RUN_ASSERTION_TIMEOUT_MS = 20_000;

const args = parseArgs(process.argv.slice(2));
const runSuffix = args.suffix || timestampSuffix();

const names = {
  ingredient: `秋葵自动测${runSuffix}`,
  food: `盒装牛奶自动测${runSuffix}`,
  recipe: `秋葵凉拌菜自动测${runSuffix}`,
  shoppingIngredient: `秋葵自动测${runSuffix}`,
  loopFood: `早餐豆乳自动测${runSuffix}`,
  rejectedIngredient: `拒绝食材自动测${runSuffix}`,
  rejectedFood: `拒绝食物自动测${runSuffix}`,
};

const coreCases = [
  {
    key: 'ingredient_create',
    skill: 'ingredient_profile',
    prompt: `帮我新增一个食材：${names.ingredient}。类型优先选择系统已有的“蔬菜”，默认单位按根，常温保存，不设置保质期；如果系统已有同名食材就更新它，不要重复创建。`,
    panelTexts: [names.ingredient],
    expectedTools: ['ingredient_profile.create_draft'],
    expectedApprovalTypes: ['ingredient.create', 'ingredient_profile.create', 'ingredient.update'],
    rejectSafe: true,
  },
  {
    key: 'ingredient_update',
    skill: 'ingredient_profile',
    prompt: `把${names.ingredient}的默认保存位置改成冷藏，备注写成焯水后更适合凉拌。`,
    panelTexts: [names.ingredient, '冷藏'],
    expectedTools: ['ingredient_profile.create_draft'],
    expectedApprovalTypes: ['ingredient.update'],
    dependsOn: ['ingredient_create'],
  },
  {
    key: 'inventory_restock',
    skill: 'inventory_analysis',
    prompt: `把今天买的${names.ingredient} 3 根录入库存，状态新鲜，放冷藏。这个食材应该优先使用已有的${names.ingredient}档案。`,
    panelTexts: [names.ingredient],
    expectedTools: ['inventory.create_operation_draft'],
    expectedApprovalTypes: ['inventory.operation'],
    dependsOn: ['ingredient_create'],
  },
  {
    key: 'inventory_consume',
    skill: 'inventory_analysis',
    prompt: `今天用了 1 根${names.ingredient}，请从库存里扣减。`,
    panelTexts: [names.ingredient],
    expectedTools: ['inventory.create_operation_draft'],
    expectedApprovalTypes: ['inventory.operation'],
    dependsOn: ['inventory_restock'],
  },
  {
    key: 'food_create',
    skill: 'food_profile',
    prompt: `新增一个食物资料：${names.food}，类型从已有选项里选“即食”，适合早餐；如果同名食物已存在就更新它，不要重复创建。`,
    panelTexts: [names.food],
    expectedTools: ['food_profile.create_draft'],
    expectedApprovalTypes: ['food_profile.create', 'food.update'],
    rejectSafe: true,
  },
  {
    key: 'food_favorite',
    skill: 'food_profile',
    prompt: `把${names.food}加入常用收藏。`,
    panelTexts: [names.food],
    expectedTools: ['food_profile.create_draft'],
    expectedApprovalTypes: ['food.favorite'],
    dependsOn: ['food_create'],
  },
  {
    key: 'recipe_create',
    skill: 'recipe_draft',
    prompt: `帮我新增一道${names.recipe}的菜谱，2 人份，难度从已有选项里选“简单”。食材只使用已有的${names.ingredient} 2 根，不要临时编造食材 ID；步骤写清楚焯水、沥干和调味。`,
    panelTexts: [names.recipe],
    expectedTools: ['recipe.create_draft'],
    expectedApprovalTypes: ['recipe.create'],
    dependsOn: ['ingredient_create'],
  },
  {
    key: 'recipe_update',
    skill: 'recipe_draft',
    prompt: `把${names.recipe}改成 3 人份，步骤里补充“拌好后静置 5 分钟再装盘”。`,
    panelTexts: [names.recipe, '3'],
    expectedTools: ['recipe.create_draft'],
    expectedApprovalTypes: ['recipe.update'],
    dependsOn: ['recipe_create'],
  },
  {
    key: 'meal_plan_create',
    skill: 'meal_plan',
    prompt: `把明天晚餐追加安排成${names.food}；如果明天晚餐已有其他计划，也保留现有计划并追加为新的计划，不要替换任何已有计划。`,
    panelTexts: [names.food],
    expectedTools: ['meal_plan.create_draft'],
    expectedApprovalTypes: ['meal_plan.create', 'meal_plan.apply'],
    dependsOn: ['food_create'],
  },
  {
    key: 'meal_plan_update',
    skill: 'meal_plan',
    prompt: `把明天晚餐里${names.food}的备注改成“自动测试少糖”，不要换成不存在的食物。`,
    panelTexts: [names.food, '少糖'],
    expectedTools: ['meal_plan.create_draft'],
    expectedApprovalTypes: ['meal_plan.apply'],
    dependsOn: ['meal_plan_create'],
  },
  {
    key: 'shopping_create',
    skill: 'shopping_list',
    prompt: `把${names.shoppingIngredient}加入购物清单，数量 2 根，原因是自动测试采购。`,
    panelTexts: [names.shoppingIngredient],
    expectedTools: ['shopping.create_draft'],
    expectedApprovalTypes: ['shopping_list.create', 'shopping_list.apply'],
    dependsOn: ['ingredient_create'],
    humanInputAnswers: [
      {
        questionHints: ['仍要加入购物清单', '库存'],
        optionHints: ['仍加入', '继续加入', '照常加入'],
      },
    ],
  },
  {
    key: 'shopping_done',
    skill: 'shopping_list',
    prompt: `把购物清单里的${names.shoppingIngredient}标记为已买。`,
    panelTexts: [names.shoppingIngredient],
    expectedTools: ['shopping.create_draft'],
    expectedApprovalTypes: ['shopping_list.apply'],
    dependsOn: ['shopping_create'],
    continuationApprovals: [
      {
        skill: 'inventory_analysis',
        panelTexts: [names.shoppingIngredient],
        expectedTools: ['inventory.create_operation_draft'],
        expectedApprovalTypes: ['inventory.operation'],
      },
    ],
  },
  {
    key: 'meal_log_create',
    skill: 'meal_log',
    prompt: `记录今晚吃了${names.food}，1 份，心情不错。`,
    panelTexts: [names.food],
    expectedTools: ['meal_log.create_draft'],
    expectedApprovalTypes: ['meal_log.create'],
    dependsOn: ['food_create'],
  },
  {
    key: 'meal_log_rate',
    skill: 'meal_log',
    prompt: `给刚才那顿${names.food}打 4.5 分。`,
    panelTexts: ['4.5'],
    expectedTools: ['meal_log.create_draft'],
    expectedApprovalTypes: ['meal_log.rate_food'],
    dependsOn: ['meal_log_create'],
  },
  {
    key: 'recipe_cook',
    skill: 'recipe_cook',
    prompt: `预览开始做${names.recipe}，按 1 人份；如果库存足够，请生成做菜确认并在完成后记录到今晚晚餐，如果库存不足就说明缺什么。`,
    panelTexts: [names.recipe],
    allowHumanInput: true,
    allowNoApprovalTexts: ['库存不足', '缺少', '补库存', '调整份量'],
    expectedTools: ['recipe.preview_cook'],
    expectedApprovalTypes: ['recipe.cook'],
    dependsOn: ['recipe_create', 'inventory_restock'],
  },
];

const productLoopCases = [
  {
    key: 'food_create_to_meal_plan',
    skill: 'food_profile',
    prompt: `先新增一个食物资料：${names.loopFood}，类型选“即食”，适合早餐；确认创建后继续把它安排到明天早餐。`,
    panelTexts: [names.loopFood],
    expectedTools: ['food_profile.create_draft'],
    expectedApprovalTypes: ['food_profile.create', 'food.update'],
    continuationApprovals: [
      {
        skill: 'meal_plan',
        panelTexts: [names.loopFood],
        expectedTools: ['meal_plan.create_draft'],
        expectedApprovalTypes: ['meal_plan.create', 'meal_plan.apply'],
      },
    ],
  },
];

const rejectionCases = [
  {
    key: 'ingredient_create_reject',
    skill: 'ingredient_profile',
    prompt: `帮我新增一个食材：${names.rejectedIngredient}，类型选“蔬菜”，默认单位按个。`,
    panelTexts: [names.rejectedIngredient],
    expectedTools: ['ingredient_profile.create_draft'],
    expectedApprovalTypes: ['ingredient.create', 'ingredient_profile.create'],
    rejectSafe: true,
  },
  {
    key: 'food_create_reject',
    skill: 'food_profile',
    prompt: `帮我新增一个食物资料：${names.rejectedFood}，类型选“即食”。`,
    panelTexts: [names.rejectedFood],
    expectedTools: ['food_profile.create_draft'],
    expectedApprovalTypes: ['food_profile.create'],
    rejectSafe: true,
  },
];

const destructiveCases = [
  {
    key: 'recipe_delete',
    skill: 'recipe_draft',
    prompt: `删除${names.recipe}这道菜谱。`,
    panelTexts: [names.recipe, '删除'],
    expectedTools: ['recipe.create_draft'],
    expectedApprovalTypes: ['recipe.delete'],
    dependsOn: ['recipe_create'],
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
    listCases: false,
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
    } else if (arg === '--list-cases') {
      result.listCases = true;
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
  --decision=approve|reject|none       审批动作；reject + core 会运行独立拒绝用例
  --cases=core|product|rejection|destructive|diagnostics|all|a,b
                                        运行用例集合或逗号分隔 key，默认 core
  --include-destructive                在 core 后追加删除类用例
  --list-cases                         只输出依赖展开后的用例顺序，不启动服务
  --suffix=ABC                         测试对象名称后缀，默认按时间生成
  --headed                             有界面运行
  --slow-mo=250                        每步操作延迟，方便观察

用例组：
  core        单 Skill 主流程；shopping_done 会继续完成第二段入库审批
  product     购物到入库、Food 到餐食计划的多 Skill continuation
  rejection   两条互不依赖的拒绝审批用例，必须配合 --decision=reject
  destructive 自动补齐依赖后删除本次后缀对应的测试菜谱

人工确认：
  case 声明 humanInputAnswers 后会自动匹配并点击；未声明的问题会立即报错，不会猜答案。

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
  const allCases = [...coreCases, ...productLoopCases, ...rejectionCases, ...destructiveCases, ...diagnosticCases];
  const byKey = new Map(allCases.map((testCase) => [testCase.key, testCase]));
  let requested;
  if (args.cases === 'core') {
    requested = args.decision === 'reject' ? rejectionCases : coreCases;
    if (args.includeDestructive && args.decision === 'approve') requested = [...requested, ...destructiveCases];
  } else if (args.cases === 'product') {
    requested = [coreCases.find((item) => item.key === 'shopping_done'), ...productLoopCases].filter(Boolean);
  } else if (args.cases === 'rejection') {
    requested = rejectionCases;
  } else if (args.cases === 'destructive') {
    requested = destructiveCases;
  } else if (args.cases === 'diagnostics') {
    requested = diagnosticCases;
  } else if (args.cases === 'all') {
    requested = [...coreCases, ...productLoopCases, ...destructiveCases];
  } else {
    requested = args.cases.split(',').map((key) => {
      const testCase = byKey.get(key.trim());
      if (!testCase) {
        throw new Error(`未知用例 key：${key}`);
      }
      return testCase;
    });
  }

  if (args.cases === 'rejection' && args.decision !== 'reject') {
    throw new Error('rejection 用例组必须配合 --decision=reject。');
  }
  if (args.decision === 'reject' && requested.some((testCase) => !testCase.rejectSafe)) {
    throw new Error('reject 模式只能运行独立拒绝用例；使用 --cases=rejection，或选择标记为 rejectSafe 的单个用例。');
  }
  if (args.decision === 'none' && !args.suffix && requested.some((testCase) => testCase.dependsOn?.length)) {
    throw new Error('none 模式不会自动执行依赖；运行依赖用例时请通过 --suffix 复用已存在的测试数据。');
  }
  const selected = args.decision === 'approve'
    ? expandCaseDependencies(requested, byKey)
    : dedupeCases(requested);
  return [
    ...selected.filter((testCase) => !testCase.allowHumanInput),
    ...selected.filter((testCase) => testCase.allowHumanInput),
  ];
}

function expandCaseDependencies(requested, byKey) {
  const result = [];
  const visiting = new Set();
  const added = new Set();
  const visit = (testCase) => {
    if (added.has(testCase.key)) return;
    if (visiting.has(testCase.key)) throw new Error(`用例依赖存在循环：${testCase.key}`);
    visiting.add(testCase.key);
    for (const dependencyKey of testCase.dependsOn ?? []) {
      const dependency = byKey.get(dependencyKey);
      if (!dependency) throw new Error(`用例 ${testCase.key} 缺少依赖：${dependencyKey}`);
      visit(dependency);
    }
    visiting.delete(testCase.key);
    added.add(testCase.key);
    result.push(testCase);
  };
  requested.forEach(visit);
  return result;
}

function dedupeCases(cases) {
  return [...new Map(cases.map((testCase) => [testCase.key, testCase])).values()];
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
let activeConversationId = '';
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
  const conversationsBefore = await fetchAiConversations(page, args.backendUrl);
  const conversationSnapshot = new Map(
    conversationsBefore.map((conversation) => [conversation.id, conversation.last_message_at || conversation.created_at || ''])
  );
  const previousRunIds = activeConversationId
    ? new Set((await fetchAiMessages(page, args.backendUrl, activeConversationId)).map((message) => message.run_id).filter(Boolean))
    : new Set();
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

  activeConversationId = await waitForTurnConversationId(
    page,
    args.backendUrl,
    conversationSnapshot,
    activeConversationId
  );
  const runId = await waitForNewRunId(page, args.backendUrl, activeConversationId, previousRunIds);
  const waitResult = await waitForApprovalOrAllowedNoApproval(
    page,
    panelCountBefore,
    testCase,
    activeConversationId
  );
  const humanInputs = waitResult.humanInputs ?? [];
  const observedSkills = [testCase.skill];
  const observedTools = [...(testCase.expectedTools ?? [])];
  if (waitResult.type === 'allowed-no-approval') {
    const events = await assertRunEvents(page, runId, observedSkills, observedTools, testCase.key);
    console.log(`[${testCase.key}] no approval: matched allowed non-approval text`);
    return caseResult(testCase, startedAt, 'no-approval-allowed', {
      matchedText: waitResult.matchedText,
      conversation: await latestConversationRunState(page, args.backendUrl, activeConversationId),
      conversationId: activeConversationId,
      runId,
      events,
      humanInputs,
    });
  }
  if (waitResult.type === 'human-input') {
    const events = await assertRunEvents(page, runId, observedSkills, [], testCase.key);
    console.log(`[${testCase.key}] human input required: allowed by case`);
    return caseResult(testCase, startedAt, 'human-input-required', {
      panelText: await panelContent(waitResult.panel),
      conversation: await latestConversationRunState(page, args.backendUrl, activeConversationId),
      conversationId: activeConversationId,
      runId,
      events,
      humanInputs,
    });
  }

  const approvalSteps = [testCase, ...(testCase.continuationApprovals ?? [])];
  const approvals = [];
  const decision = args.decision === 'approve' ? 'approved' : 'rejected';
  let panel = waitResult.panel;
  for (let index = 0; index < approvalSteps.length; index += 1) {
    const step = approvalSteps[index];
    if (index > 0) {
      observedSkills.push(step.skill);
      observedTools.push(...(step.expectedTools ?? []));
    }
    const assertion = await assertApprovalStep(
      page,
      panel,
      step,
      activeConversationId,
      runId,
      `${testCase.key}#${index + 1}`
    );
    approvals.push(assertion);

    if (args.decision === 'none') {
      const events = await assertRunEvents(page, runId, observedSkills, observedTools, testCase.key);
      console.log(`[${testCase.key}] approval pending; --decision=none，脚本停止在当前页面。`);
      return caseResult(testCase, startedAt, 'pending', {
        approval: assertion.panel,
        approvals,
        panelText: assertion.panelText,
        conversationId: activeConversationId,
        runId,
        events,
        humanInputs,
      });
    }

    const panelCountBeforeDecision = await page.locator('.ai-approval-panel').count();
    await waitForApprovalReady(page, testCase.key, activeConversationId);
    await submitDecision(panel, decision);
    await waitForDecisionStatus(panel, decision);

    if (decision === 'rejected') break;
    if (index < approvalSteps.length - 1) {
      panel = await waitForNewApprovalPanel(page, panelCountBeforeDecision, `${testCase.key} continuation`);
    }
  }

  await waitForConversationIdle(page, testCase.key, activeConversationId);
  await waitForComposerReady(page);
  const events = await assertRunEvents(page, runId, observedSkills, observedTools, testCase.key);
  console.log(`[${testCase.key}] ${decision}`);
  return caseResult(testCase, startedAt, decision, {
    approval: approvals.at(-1)?.panel,
    approvals,
    conversation: await latestConversationRunState(page, args.backendUrl, activeConversationId),
    conversationId: activeConversationId,
    runId,
    events,
    humanInputs,
  });
}

async function assertApprovalStep(page, panel, step, conversationId, runId, label) {
  const panelText = await panelContent(panel);
  for (const expected of step.panelTexts ?? []) {
    if (!panelText.includes(expected)) {
      throw new Error(`[${label}] 审批面板缺少预期文本：${expected}\n--- panel ---\n${panelText}`);
    }
  }
  const pendingApprovals = await fetchPendingApprovals(page, args.backendUrl, conversationId);
  const pending = [...pendingApprovals]
    .reverse()
    .find((approval) => !approval.run_id || approval.run_id === runId);
  if (!pending) {
    throw new Error(`[${label}] 找不到当前 run 的 pending approval：${runId}`);
  }
  if (step.expectedApprovalTypes?.length && !step.expectedApprovalTypes.includes(pending.approval_type)) {
    throw new Error(
      `[${label}] approval_type 不符合预期：实际 ${pending.approval_type}，预期 ${step.expectedApprovalTypes.join(' / ')}`
    );
  }
  return {
    panel: await approvalPanelMeta(panel),
    panelText,
    approvalId: pending.id,
    approvalType: pending.approval_type,
    draftSchemaVersion: pending.draft_schema_version,
  };
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

async function runDiagnostics(page, { expectedRunIds = [] } = {}) {
  console.log('\n[diagnostics] AI 质量诊断弹窗');
  const metrics = await fetchAiQualityMetrics(page, args.backendUrl);
  const recentRunIds = new Set((metrics.recent_runs ?? []).map((run) => run.id));
  const missingRunIds = expectedRunIds.filter((runId) => !recentRunIds.has(runId));
  if (missingRunIds.length > 0) {
    throw new Error(`AI 质量指标没有包含刚执行的 run：${missingRunIds.join(', ')}`);
  }
  await page.locator('.ai-quality-trigger').click();
  await expectVisibleText(page, 'AI 质量诊断', 'AI 质量诊断弹窗');
  const diagnosticsRoot = page.locator('.ai-quality-modal').last();
  await diagnosticsRoot
    .getByText(metrics.run_count > 0 ? '常用 Skill' : '发起一次 AI 任务后', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(async (error) => {
      const text = await diagnosticsRoot.innerText().catch(() => '');
      throw new Error(
        `AI 质量诊断没有进入成功态：${error instanceof Error ? error.message : String(error)}\n${text.slice(0, 1_000)}`
      );
    });
  const diagnosticsText = await diagnosticsRoot.innerText();
  if (diagnosticsText.includes('暂时读不到指标')) {
    throw new Error('AI 质量诊断接口返回错误态。');
  }
  if (metrics.run_count > 0) {
    for (const expected of ['常用 Skill', '无效身份拒绝', '跨步骤拒绝', '工具预算耗尽']) {
      if (!diagnosticsText.includes(expected)) {
        throw new Error(`AI 质量诊断缺少预期内容：${expected}`);
      }
    }
  } else if (!diagnosticsText.includes('发起一次 AI 任务后')) {
    throw new Error('AI 质量诊断空状态不符合预期。');
  }
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
    metrics: {
      runCount: metrics.run_count,
      operational: metrics.operational_metrics,
    },
  };
}

async function waitForApprovalOrAllowedNoApproval(page, panelCountBefore, testCase, conversationId) {
  const startedAt = Date.now();
  let approvalPanelCount = panelCountBefore;
  let humanInputCountBefore = await page.locator('.ai-human-input-request').count();
  let answerIndex = 0;
  const humanInputs = [];
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const failureText = await latestExecutionFailureText(page);
    if (failureText) {
      throw new Error(`[${testCase.key}] AI 执行失败：${failureText}`);
    }
    const humanInputError = await page
      .locator('.ai-human-input-request .form-error')
      .last()
      .innerText()
      .catch(() => '');
    if (humanInputError.trim()) {
      throw new Error(`[${testCase.key}] 人工确认提交失败：${humanInputError.trim()}`);
    }
    const humanInputPanels = page.locator('.ai-human-input-request');
    const humanInputCount = await humanInputPanels.count();
    if (humanInputCount > humanInputCountBefore) {
      const panel = humanInputPanels.nth(humanInputCount - 1);
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      const answerPolicy = testCase.humanInputAnswers?.[answerIndex];
      if (answerPolicy) {
        approvalPanelCount = await page.locator('.ai-approval-panel').count();
        const answer = await submitHumanInputAnswer(panel, answerPolicy, `${testCase.key}#human-${answerIndex + 1}`);
        humanInputs.push(answer);
        answerIndex += 1;
        humanInputCountBefore = humanInputCount;
        console.log(`[${testCase.key}] human input: ${answer.selectedOption}`);
        continue;
      }
      if (testCase.allowHumanInput) return { type: 'human-input', panel, humanInputs };
      const panelText = await panelContent(panel);
      throw new Error(
        `[${testCase.key}] 遇到未配置自动答案的人工确认。请为该 case 增加 humanInputAnswers。\n--- human input ---\n${panelText}`
      );
    }
    const panels = page.locator('.ai-approval-panel');
    const panelCount = await panels.count();
    if (panelCount > approvalPanelCount) {
      const panel = panels.nth(panelCount - 1);
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      return { type: 'approval', panel, humanInputs };
    }
    if (testCase.allowNoApprovalTexts?.length) {
      const state = await latestConversationRunState(page, args.backendUrl, conversationId).catch(() => null);
      if (state && !state.active && state.status !== 'empty' && Date.now() - startedAt > 2_000) {
        const assistantText = await latestAssistantText(page);
        const matchedText = testCase.allowNoApprovalTexts.find((text) => assistantText.includes(text));
        if (matchedText) {
          return { type: 'allowed-no-approval', matchedText, humanInputs };
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

async function submitHumanInputAnswer(panel, policy, label) {
  const question = (await panel.locator('.ai-approval-title-row h3').first().innerText()).replace(/\s+/g, ' ').trim();
  for (const expected of policy.questionHints ?? []) {
    if (!question.includes(expected)) {
      throw new Error(`[${label}] 人工确认问题不符合预期：缺少“${expected}”\nquestion=${question}`);
    }
  }
  const options = panel.locator('.ai-clarification-option:not(.ai-clarification-option-manual)');
  const optionTexts = (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
  const selected = chooseHumanInputOption(optionTexts, policy.optionHints ?? []);
  await options.nth(selected.index).click();
  await panel
    .getByText('已提交', { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
    .catch((error) => {
      throw new Error(`[${label}] 提交人工确认超时：${error instanceof Error ? error.message : String(error)}`);
    });
  return {
    question,
    selectedOption: selected.text,
    availableOptions: optionTexts,
  };
}

async function waitForNewApprovalPanel(page, panelCountBefore, label) {
  const panels = page.locator('.ai-approval-panel');
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length > count,
    { selector: '.ai-approval-panel', count: panelCountBefore },
    { timeout: DEFAULT_TIMEOUT_MS }
  ).catch((error) => {
    throw new Error(`[${label}] 等待后续审批面板超时：${error instanceof Error ? error.message : String(error)}`);
  });
  const panel = panels.last();
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  return panel;
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
  return fetchAuthenticatedJson(page, backendUrl, '/api/ai/status').catch(() => null);
}

async function fetchAiRegistry(page, backendUrl) {
  return fetchAuthenticatedJson(page, backendUrl, '/api/ai/registry');
}

async function fetchAiQualityMetrics(page, backendUrl) {
  return fetchAuthenticatedJson(page, backendUrl, '/api/ai/quality-metrics?limit=200');
}

async function fetchAiConversations(page, backendUrl) {
  const payload = await fetchAuthenticatedJson(page, backendUrl, '/api/ai/conversations');
  if (!Array.isArray(payload)) throw new Error('/api/ai/conversations 返回格式无效。');
  return payload;
}

async function fetchAiMessages(page, backendUrl, conversationId) {
  const payload = await fetchAuthenticatedJson(
    page,
    backendUrl,
    `/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`
  );
  if (!Array.isArray(payload)) throw new Error('AI 消息接口返回格式无效。');
  return payload;
}

async function fetchPendingApprovals(page, backendUrl, conversationId) {
  const payload = await fetchAuthenticatedJson(
    page,
    backendUrl,
    `/api/ai/conversations/${encodeURIComponent(conversationId)}/approvals/pending`
  );
  if (!Array.isArray(payload)) throw new Error('AI pending approvals 接口返回格式无效。');
  return payload;
}

async function fetchRunEvents(page, backendUrl, runId) {
  const payload = await fetchAuthenticatedJson(page, backendUrl, `/api/ai/runs/${encodeURIComponent(runId)}/events`);
  if (!Array.isArray(payload)) throw new Error('AI run events 接口返回格式无效。');
  return payload;
}

async function fetchAuthenticatedJson(page, backendUrl, path) {
  const result = await page.evaluate(async ({ url, requestPath }) => {
    const token = localStorage.getItem('culina-access-token');
    if (!token) return { ok: false, status: 401, detail: 'missing token' };
    const response = await fetch(`${url.replace(/\/$/, '')}${requestPath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  }, { url: backendUrl, requestPath: path });
  if (!result.ok) {
    const detail = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? result.detail ?? '');
    throw new Error(`${path} 请求失败：HTTP ${result.status}${detail ? `，${detail.slice(0, 500)}` : ''}`);
  }
  return result.data;
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

async function waitForDecisionStatus(panel, decision) {
  const expectedText = decision === 'approved' ? '已确认' : '已拒绝';
  await panel
    .getByText(expectedText, { exact: false })
    .first()
    .waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS })
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

async function waitForApprovalReady(page, label, conversationId) {
  const startedAt = Date.now();
  let lastState = 'no conversation';
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const state = await latestConversationRunState(page, args.backendUrl, conversationId);
    lastState = state.description;
    if (state.status === 'waiting_approval') return;
    if (!state.active && state.status !== 'empty') {
      throw new Error(`[${label}] 审批面板出现，但 run 已进入 ${state.status}。`);
    }
    await delay(500);
  }
  throw new Error(`[${label}] 等待审批可确认超时：${lastState}`);
}

async function waitForConversationIdle(page, label, conversationId) {
  const startedAt = Date.now();
  let idleSince = 0;
  let lastState = 'no conversation';
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const state = await latestConversationRunState(page, args.backendUrl, conversationId);
    lastState = state.description;
    if (!state.active) {
      if (['failed', 'cancelled'].includes(state.status)) {
        throw new Error(`[${label}] run 以 ${state.status} 结束：${state.description}`);
      }
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= IDLE_STABLE_MS) return;
    } else {
      idleSince = 0;
    }
    await delay(500);
  }
  throw new Error(`[${label}] 等待会话空闲超时：${lastState}`);
}

async function latestConversationRunState(page, backendUrl, conversationId) {
  if (!conversationId) return { active: false, status: 'empty', description: 'missing conversation id' };
  const conversations = await fetchAiConversations(page, backendUrl);
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    return { active: false, status: 'empty', id: conversationId, description: `${conversationId} not found` };
  }
  const status = String(conversation.last_run_status || '').toLowerCase();
  return {
    active: ACTIVE_RUN_STATUSES.has(status),
    status: status || 'empty',
    id: conversation.id,
    title: conversation.title || conversation.prompt || '',
    lastMessageAt: conversation.last_message_at || '',
    description: `${conversation.id} last_run_status=${status || 'empty'}`,
  };
}

async function waitForTurnConversationId(page, backendUrl, snapshot, preferredConversationId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < RUN_ASSERTION_TIMEOUT_MS) {
    const conversations = await fetchAiConversations(page, backendUrl);
    if (preferredConversationId) {
      const preferred = conversations.find((item) => item.id === preferredConversationId);
      const previousTimestamp = snapshot.get(preferredConversationId) || '';
      const nextTimestamp = preferred?.last_message_at || preferred?.created_at || '';
      if (preferred && nextTimestamp !== previousTimestamp) return preferredConversationId;
    }
    const created = conversations.find((item) => !snapshot.has(item.id));
    if (created) return created.id;
    const changed = conversations.find((item) => {
      const previousTimestamp = snapshot.get(item.id);
      return previousTimestamp !== undefined && previousTimestamp !== (item.last_message_at || item.created_at || '');
    });
    if (changed) return changed.id;
    await delay(250);
  }
  throw new Error('发送消息后未能确定本轮 conversation_id。');
}

async function waitForNewRunId(page, backendUrl, conversationId, previousRunIds) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const messages = await fetchAiMessages(page, backendUrl, conversationId);
    const message = [...messages]
      .reverse()
      .find((item) => item.run_id && !previousRunIds.has(item.run_id));
    if (message?.run_id) return message.run_id;
    await delay(300);
  }
  throw new Error(`发送消息后未能确定本轮 run_id：${conversationId}`);
}

async function assertRunEvents(page, runId, expectedSkills, expectedTools, label) {
  const expectedSkillCodes = [...new Set(expectedSkills.filter(Boolean).map((skill) => `${skill}.start`))];
  const expectedToolCodes = [...new Set(expectedTools.filter(Boolean))];
  const startedAt = Date.now();
  let events = [];
  while (Date.now() - startedAt < RUN_ASSERTION_TIMEOUT_MS) {
    events = await fetchRunEvents(page, args.backendUrl, runId);
    const completedSkillCodes = new Set(
      events.filter((event) => event.type === 'skill' && event.status === 'completed').map((event) => event.internal_code)
    );
    const completedToolCodes = new Set(
      events
        .filter((event) => ['tool', 'script'].includes(event.type) && event.status === 'completed')
        .map((event) => event.internal_code)
    );
    const missingSkills = expectedSkillCodes.filter((code) => !completedSkillCodes.has(code));
    const missingTools = expectedToolCodes.filter((code) => !completedToolCodes.has(code));
    if (missingSkills.length === 0 && missingTools.length === 0) {
      return summarizeRunEvents(events);
    }
    await delay(300);
  }
  const skillCodes = events
    .filter((event) => event.type === 'skill' && event.status === 'completed')
    .map((event) => event.internal_code);
  const toolCodes = events
    .filter((event) => ['tool', 'script'].includes(event.type) && event.status === 'completed')
    .map((event) => event.internal_code);
  const missingSkills = expectedSkillCodes.filter((code) => !skillCodes.includes(code));
  const missingTools = expectedToolCodes.filter((code) => !toolCodes.includes(code));
  throw new Error(
    `[${label}] run events 缺少预期执行记录：skills=${missingSkills.join(',') || '-'} tools=${missingTools.join(',') || '-'}\n`
    + `observed skills=${skillCodes.join(',') || '-'} tools=${toolCodes.join(',') || '-'}`
  );
}

function summarizeRunEvents(events) {
  return {
    skills: [...new Set(events.filter((event) => event.type === 'skill').map((event) => event.internal_code))],
    tools: [...new Set(events.filter((event) => ['tool', 'script'].includes(event.type)).map((event) => event.internal_code))],
    failures: events
      .filter((event) => event.status === 'failed')
      .map((event) => ({ type: event.type, code: event.internal_code, message: event.user_message })),
  };
}

function assertAiRegistry(registry, tests) {
  if (!registry || !Array.isArray(registry.skills) || !Array.isArray(registry.tools) || !Array.isArray(registry.profiles)) {
    throw new Error('/api/ai/registry 返回格式无效。');
  }
  const skills = new Map(registry.skills.map((skill) => [skill.key, skill]));
  const tools = new Map(registry.tools.map((tool) => [tool.name, tool]));
  const requiredSkillKeys = new Set();
  for (const testCase of tests) {
    if (testCase.key === 'diagnostics') continue;
    requiredSkillKeys.add(testCase.skill);
    for (const step of testCase.continuationApprovals ?? []) requiredSkillKeys.add(step.skill);
  }
  for (const skillKey of requiredSkillKeys) {
    const skill = skills.get(skillKey);
    if (!skill) throw new Error(`AI Registry 缺少 Skill：${skillKey}`);
    if (skill.runner !== 'toolcall') throw new Error(`Skill ${skillKey} runner 不是 toolcall：${skill.runner}`);
    if (!skill.tool_budget || !Number.isInteger(skill.tool_budget.max_tool_calls)) {
      throw new Error(`Skill ${skillKey} 缺少有效 tool_budget。`);
    }
    if (!skill.completion_policy || typeof skill.completion_policy !== 'object') {
      throw new Error(`Skill ${skillKey} 缺少 completion_policy。`);
    }
    for (const toolName of skill.tools ?? []) {
      const tool = tools.get(toolName);
      if (!tool) throw new Error(`Skill ${skillKey} 声明了未注册工具：${toolName}`);
      if (tool.side_effect === 'write') throw new Error(`Skill ${skillKey} 暴露了 write 工具：${toolName}`);
    }
  }
  for (const testCase of tests) {
    for (const step of [testCase, ...(testCase.continuationApprovals ?? [])]) {
      if (!step.skill || step.skill === 'workspace_diagnostics') continue;
      const allowedTools = new Set(skills.get(step.skill)?.tools ?? []);
      for (const toolName of step.expectedTools ?? []) {
        if (!allowedTools.has(toolName)) {
          throw new Error(`用例 ${testCase.key} 期望工具 ${toolName}，但 Skill ${step.skill} 未声明该工具。`);
        }
      }
    }
  }
  if (!registry.profiles.some((profile) => profile.key === 'main_workspace')) {
    throw new Error('AI Registry 缺少 main_workspace profile。');
  }
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
    latestConversation: await latestConversationRunState(page, args.backendUrl, activeConversationId).catch((reason) => ({
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
    '| case | skill | status | durationMs | run | observed |',
    '| --- | --- | --- | ---: | --- | --- |',
  ];
  for (const item of report.cases) {
    const observed = [
      item.events?.skills?.join(', '),
      item.events?.tools?.join(', '),
      item.approvals?.map((approval) => approval.approvalType).join(', '),
      item.humanInputs?.map((answer) => `回答:${answer.selectedOption}`).join(', '),
      item.matchedText,
    ].filter(Boolean).join(' / ');
    lines.push(`| ${item.key} | ${item.skill || ''} | ${item.status} | ${item.durationMs ?? ''} | ${escapeMarkdownTable(item.runId || '')} | ${escapeMarkdownTable(observed)} |`);
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
  if (args.listCases) {
    console.log(tests.map((testCase, index) => `${index + 1}. ${testCase.key}`).join('\n'));
    return;
  }
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
    context.on('page', (openedPage) => {
      openedPage.on('pageerror', (error) => pageErrors.push(error.message));
      openedPage.on('console', (message) => {
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
    assertAiRegistry(report.diagnostics.aiRegistry, tests);
    await openAiWorkspace(page);
    for (const testCase of tests) {
      currentCase = testCase;
      if (testCase.key === 'diagnostics') {
        report.cases.push(await runDiagnostics(page, {
          expectedRunIds: report.cases.map((item) => item.runId).filter(Boolean),
        }));
        continue;
      }
      const result = await runCase(page, testCase);
      report.cases.push(result);
      if (['pending', 'human-input-required'].includes(result.status)) break;
    }
    if (
      report.cases.some((item) => item.runId)
      && !report.cases.some((item) => item.key === 'diagnostics')
      && !report.cases.some((item) => item.status === 'pending')
    ) {
      currentCase = { key: 'diagnostics', skill: 'workspace_diagnostics' };
      report.cases.push(await runDiagnostics(page, {
        expectedRunIds: report.cases.map((item) => item.runId).filter(Boolean),
      }));
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
