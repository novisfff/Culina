import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = resolve(__dirname, '..');
const distDir = resolve(frontendRoot, 'dist');

const now = '2026-06-01T08:00:00.000Z';
const today = '2026-06-01';

const user = {
  id: 'user-smoke',
  username: 'smoke',
  display_name: 'Smoke User',
  email: 'smoke@example.com',
  phone: null,
  avatar_seed: 'Smoke User',
  avatar_image: null,
};

const membership = {
  id: 'membership-smoke',
  family_id: 'family-smoke',
  user_id: user.id,
  role: 'Owner',
  status: 'active',
};

const family = {
  id: 'family-smoke',
  name: 'Smoke 家庭厨房',
  motto: '固定前端 smoke fixture',
  location: '上海',
  image: null,
  created_at: now,
  updated_at: now,
  ai_recommendations: [],
};

const member = {
  ...user,
  role: membership.role,
  status: membership.status,
};

const ingredient = {
  id: 'ingredient-egg',
  family_id: family.id,
  name: '鸡蛋',
  category: '蛋奶',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 14,
  default_low_stock_threshold: 4,
  notes: 'smoke fixture',
  image: null,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const inventoryItem = {
  id: 'inventory-egg',
  family_id: family.id,
  ingredient_id: ingredient.id,
  ingredient_name: ingredient.name,
  quantity: 6,
  consumed_quantity: 0,
  remaining_quantity: 6,
  unit: '个',
  entered_quantity: 6,
  entered_unit: '个',
  status: 'fresh',
  purchase_date: today,
  expiry_date: '2026-06-15',
  storage_location: '冷藏',
  notes: '',
  low_stock_threshold: 4,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const recipe = {
  id: 'recipe-egg',
  family_id: family.id,
  title: '番茄炒蛋',
  servings: 2,
  prep_minutes: 15,
  difficulty: 'easy',
  ingredient_items: [
    {
      id: 'recipe-ingredient-egg',
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: 2,
      unit: '个',
      note: '',
    },
  ],
  steps: [
    {
      id: 'step-1',
      title: '炒制',
      text: '热锅后下蛋液和番茄。',
      icon: 'pan',
      summary: '快速翻炒',
      estimated_minutes: 10,
      tip: '',
      key_points: [],
    },
  ],
  tips: '出锅前调味。',
  scene_tags: ['家常'],
  images: [],
  cook_logs: [],
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const food = {
  id: 'food-egg',
  family_id: family.id,
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常菜',
  flavor_tags: ['咸鲜'],
  scene_tags: ['家常'],
  suitable_meal_types: ['lunch', 'dinner'],
  source_name: '家里做',
  purchase_source: '',
  scene: '日常',
  images: [],
  notes: '',
  routine_note: '',
  price: null,
  rating: 4,
  repurchase: true,
  expiry_date: null,
  stock_quantity: null,
  stock_unit: '份',
  favorite: true,
  recipe_id: recipe.id,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const authResponse = {
  access_token: 'smoke-token',
  user,
  membership,
  family,
};

const emptyDiscoverySection = {
  recipe_ids: [],
  recipes: [],
};

const fixtures = {
  '/api/auth/me': authResponse,
  '/api/family': family,
  '/api/members': [member],
  '/api/ingredients': [ingredient],
  '/api/inventory': [inventoryItem],
  '/api/shopping-list': [],
  '/api/recipes': [recipe],
  '/api/recipes/discovery': {
    recommended: { recipe_ids: [recipe.id], recipes: [recipe] },
    ready: { recipe_ids: [recipe.id], recipes: [recipe] },
    quick: emptyDiscoverySection,
    missing: emptyDiscoverySection,
  },
  '/api/recipes/stats': {
    total_cooks: 0,
    recently_cooked: [],
    frequent: [],
  },
  '/api/recipe-favorites': [],
  '/api/recipe-plan': [],
  '/api/food-plan': [],
  '/api/food-scenes': [],
  '/api/foods': [food],
  '/api/foods/recommendations': {
    target_meal_type: 'dinner',
    target_date: today,
    items: [
      {
        food,
        score: 0.9,
        reasons: ['适合今天安排'],
        primary_action: 'quick_add_meal',
      },
    ],
  },
  '/api/meal-logs': [],
  '/api/activity-logs': [],
  '/api/ai/conversations': [],
  '/api/media/ai-render/active': [],
  '/api/search/index-jobs/active': [],
};

function assertDistExists() {
  if (!existsSync(distDir)) {
    throw new Error('frontend/dist 不存在。请先运行 npm --prefix frontend run build。');
  }
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

async function waitForPreview(url, child) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview 提前退出，exit code: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`等待 Vite preview 超时：${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function startPreview() {
  const port = await findOpenPort();
  const child = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: frontendRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
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
    await waitForPreview(url, child);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }

  return {
    url,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
      await new Promise((resolveStop) => setTimeout(resolveStop, 250));
    },
  };
}

async function installApiMocks(context, unexpectedRequests) {
  await context.route('https://fonts.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '',
    });
  });
  await context.route('https://fonts.gstatic.com/**', async (route) => {
    await route.abort();
  });

  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: corsHeaders(),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/auth/login') {
      await fulfillJson(route, authResponse);
      return;
    }

    const fixture = fixtures[url.pathname];
    if (fixture !== undefined) {
      await fulfillJson(route, fixture);
      return;
    }

    unexpectedRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    await fulfillJson(route, { detail: `Unhandled smoke API: ${url.pathname}` }, 404);
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  });
}

async function createPage(browser, viewport, authenticated = true) {
  const context = await browser.newContext({ viewport });
  const unexpectedRequests = [];
  const pageErrors = [];
  const consoleErrors = [];

  await installApiMocks(context, unexpectedRequests);
  if (authenticated) {
    await context.addInitScript(() => {
      localStorage.setItem('culina-access-token', 'smoke-token');
      localStorage.setItem('culina-active-tab-v4', 'home');
    });
  }

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  return {
    context,
    page,
    assertClean: () => {
      if (unexpectedRequests.length > 0) {
        throw new Error(`未 mock 的 API 请求：\n${unexpectedRequests.join('\n')}`);
      }
      if (pageErrors.length > 0) {
        throw new Error(`页面运行错误：\n${pageErrors.join('\n')}`);
      }
      const relevantConsoleErrors = consoleErrors.filter((message) => !message.includes('Failed to load resource'));
      if (relevantConsoleErrors.length > 0) {
        throw new Error(`浏览器 console error：\n${relevantConsoleErrors.join('\n')}`);
      }
    },
  };
}

async function expectVisible(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 }).catch((error) => {
    throw new Error(`${label} 未渲染：${error instanceof Error ? error.message : String(error)}`);
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
      { timeout: 10_000 }
    )
    .catch((error) => {
      throw new Error(`${label} 未渲染：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function expectNoHorizontalOverflow(page, label) {
  const result = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const body = document.body;
    const overflow = Math.max(documentElement.scrollWidth, body.scrollWidth) - documentElement.clientWidth;
    const overflowingElements =
      overflow > 2
        ? Array.from(document.querySelectorAll('body *'))
            .filter((element) => element.getBoundingClientRect().right > documentElement.clientWidth + 2)
            .slice(0, 5)
            .map((element) => ({
              className: element.className,
              right: Math.round(element.getBoundingClientRect().right),
              width: Math.round(element.getBoundingClientRect().width),
            }))
        : [];
    return {
      overflow,
      overflowingElements,
      viewportWidth: window.innerWidth,
      tabletMediaMatches: window.matchMedia('(min-width: 901px) and (max-width: 1280px)').matches,
    };
  });
  if (result.overflow > 2) {
    throw new Error(
      `${label} 出现横向溢出：${result.overflow}px，视口 ${result.viewportWidth}px，平板规则 ${
        result.tabletMediaMatches ? '已启用' : '未启用'
      }\n${JSON.stringify(result.overflowingElements, null, 2)}`
    );
  }
}

async function runLoginSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1280, height: 900 }, false);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '登录家庭厨房' }), '登录页标题');
  await expectVisible(page.getByRole('button', { name: '进入家庭厨房' }), '登录按钮');
  await expectNoHorizontalOverflow(page, '登录页');
  assertClean();
  await context.close();
}

async function runDesktopSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1440, height: 960 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisibleText(page, '家庭厨房工作台', '桌面首页工作台标识');
  await expectVisible(page.getByRole('heading', { name: '首页' }), '桌面首页标题');
  await expectNoHorizontalOverflow(page, '桌面首页');

  await page.getByRole('button', { name: '食物' }).first().click();
  await expectVisibleText(page, '食物库', '食物工作台');

  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '管理家庭食材档案、库存状态以及采购清单。', '食材工作台');

  await page.getByRole('button', { name: '菜谱' }).first().click();
  await expectVisibleText(page, '菜谱', '菜谱工作台');
  await expectNoHorizontalOverflow(page, '桌面工作台切换');
  assertClean();
  await context.close();
}

async function runResponsiveSmoke(browser, baseUrl, viewport, label) {
  const { context, page, assertClean } = await createPage(browser, viewport);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisibleText(page, '家庭厨房工作台', `${label} 工作台标识`);
  await expectNoHorizontalOverflow(page, label);
  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '食材', `${label} 食材入口`);
  await expectNoHorizontalOverflow(page, `${label} 食材页`);
  assertClean();
  await context.close();
}

async function runTabletLandscapeSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1112, height: 834 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '首页' }), '1112x834 首页标题');
  await expectNoHorizontalOverflow(page, '1112x834 首页');

  const layout = await page.evaluate(() => {
    const statGrid = document.querySelector('.dashboard-stat-grid');
    const foodRow = document.querySelector('.dashboard-food-row');
    return {
      statColumns: statGrid ? getComputedStyle(statGrid).gridTemplateColumns.split(' ').length : 0,
      foodColumns: foodRow ? getComputedStyle(foodRow).gridTemplateColumns.split(' ').length : 0,
    };
  });

  if (layout.statColumns !== 4 || layout.foodColumns !== 3) {
    throw new Error(
      `1112x834 首页布局提前降级：统计区 ${layout.statColumns} 列，推荐区 ${layout.foodColumns} 列`
    );
  }

  assertClean();
  await context.close();
}

async function runTabletAirWorkspaceSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1180, height: 820 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '首页' }), '1180x820 首页标题');
  await expectVisible(page.locator('.dashboard-lower-grid'), '1180x820 首页摘要区');
  await expectNoHorizontalOverflow(page, '1180x820 首页');
  const homeCompactLayout = await page.evaluate(() => {
    const styles = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element) : null;
    };
    const columnCount = (selector) => styles(selector)?.gridTemplateColumns.split(' ').length ?? 0;
    return {
      lowerColumns: columnCount('.dashboard-lower-grid'),
      expiryColumns: columnCount('.dashboard-expiry-list'),
      todoColumns: columnCount('.dashboard-todo-list'),
      activityColumns: columnCount('.dashboard-activity-list'),
      weekOrder: styles('.dashboard-week-panel')?.order ?? 'missing',
      expiryOrder: styles('.dashboard-expiry-panel')?.order ?? 'missing',
      todoOrder: styles('.dashboard-todo-panel')?.order ?? 'missing',
    };
  });
  if (
    homeCompactLayout.lowerColumns !== 2 ||
    homeCompactLayout.expiryColumns !== 1 ||
    homeCompactLayout.todoColumns !== 1 ||
    homeCompactLayout.activityColumns !== 1 ||
    homeCompactLayout.weekOrder !== '1' ||
    homeCompactLayout.expiryOrder !== '2' ||
    homeCompactLayout.todoOrder !== '3'
  ) {
    throw new Error(
      `1180x820 首页摘要布局异常：主区 ${homeCompactLayout.lowerColumns} 列，临期 ${homeCompactLayout.expiryColumns} 列，待办 ${homeCompactLayout.todoColumns} 列，记录 ${homeCompactLayout.activityColumns} 列`
    );
  }

  await page.getByRole('button', { name: '食物' }).first().click();
  await expectVisibleText(page, '食物库', '1180x820 食物页');
  await expectNoHorizontalOverflow(page, '1180x820 食物页');
  const foodLayout = await page.evaluate(() => {
    const columnCount = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).gridTemplateColumns.split(' ').length : 0;
    };
    return {
      contentColumns: columnCount('.food-content-layout'),
      recommendationColumns: columnCount('.food-recommendation-grid'),
      cardColumns: columnCount('.food-card-grid'),
      sidebarColumns: columnCount('.food-task-sidebar'),
      quickColumns: columnCount('.food-sidebar-quick-section .food-library-insight'),
      planColumns: columnCount('.food-plan-week'),
      sceneColumns: columnCount('.food-sidebar-scene-list'),
    };
  });
  if (
    foodLayout.contentColumns !== 1 ||
    foodLayout.recommendationColumns !== 3 ||
    foodLayout.cardColumns !== 3 ||
    foodLayout.sidebarColumns !== 2 ||
    foodLayout.quickColumns !== 3 ||
    foodLayout.planColumns !== 3 ||
    foodLayout.sceneColumns !== 3
  ) {
    throw new Error(
      `1180x820 食物页布局异常：主区 ${foodLayout.contentColumns} 列，推荐区 ${foodLayout.recommendationColumns} 列，卡片区 ${foodLayout.cardColumns} 列，辅助区 ${foodLayout.sidebarColumns} 列，视角 ${foodLayout.quickColumns} 列，菜单 ${foodLayout.planColumns} 列，场景 ${foodLayout.sceneColumns} 列`
    );
  }

  await page.getByRole('button', { name: '菜谱' }).first().click();
  await expectVisible(page.getByRole('heading', { name: '菜谱' }), '1180x820 菜谱页');
  await expectNoHorizontalOverflow(page, '1180x820 菜谱页');
  const recipeLayout = await page.evaluate(() => {
    const columnCount = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).gridTemplateColumns.split(' ').length : 0;
    };
    const favoritePanel = document.querySelector('.recipe-inspiration-favorites');
    const sideFavoritePanel = document.querySelector('.recipe-favorite-side-panel');
    const searchRow = document.querySelector('.recipe-search-row');
    const searchControls = searchRow ? Array.from(searchRow.children) : [];
    return {
      inspirationColumns: columnCount('.recipe-inspiration-grid'),
      discoveryColumns: columnCount('.recipe-discovery-layout'),
      cardColumns: columnCount('.recipe-discovery-card-grid'),
      favoriteColumns: columnCount('.recipe-inspiration-favorite-list'),
      favoriteDisplay: favoritePanel ? getComputedStyle(favoritePanel).display : 'missing',
      sideFavoriteDisplay: sideFavoritePanel ? getComputedStyle(sideFavoritePanel).display : 'missing',
      searchColumns: columnCount('.recipe-search-row'),
      searchRowTops: searchControls.map((element) => Math.round(element.getBoundingClientRect().top)),
    };
  });
  const recipeSearchTopSpread =
    recipeLayout.searchRowTops.length > 0
      ? Math.max(...recipeLayout.searchRowTops) - Math.min(...recipeLayout.searchRowTops)
      : Number.POSITIVE_INFINITY;
  if (
    recipeLayout.inspirationColumns !== 2 ||
    recipeLayout.discoveryColumns !== 1 ||
    recipeLayout.cardColumns !== 3 ||
    recipeLayout.favoriteColumns !== 2 ||
    recipeLayout.favoriteDisplay === 'none' ||
    recipeLayout.sideFavoriteDisplay !== 'none' ||
    recipeLayout.searchColumns !== 3 ||
    recipeSearchTopSpread > 2
  ) {
    throw new Error(
      `1180x820 菜谱页布局异常：概览区 ${recipeLayout.inspirationColumns} 列，内容区 ${recipeLayout.discoveryColumns} 列，卡片区 ${recipeLayout.cardColumns} 列，收藏 ${recipeLayout.favoriteColumns} 列/${recipeLayout.favoriteDisplay}，侧栏收藏 ${recipeLayout.sideFavoriteDisplay}，筛选 ${recipeLayout.searchColumns} 列/${recipeLayout.searchRowTops.join(',')}`
    );
  }

  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '管理家庭食材档案、库存状态以及采购清单。', '1180x820 食材页');
  await expectNoHorizontalOverflow(page, '1180x820 食材页');
  const ingredientFilterDisplay = await page.evaluate(() => {
    const element = document.querySelector('.ingredients-catalog-filter-bar');
    return element ? getComputedStyle(element).display : 'missing';
  });
  if (ingredientFilterDisplay !== 'grid') {
    throw new Error(`1180x820 食材筛选区未进入平板布局：${ingredientFilterDisplay}`);
  }
  const ingredientCatalogLayout = await page.evaluate(() => {
    const filterBar = document.querySelector('.ingredients-catalog-filter-bar');
    const sections = filterBar ? Array.from(filterBar.children) : [];
    return {
      columns: filterBar ? getComputedStyle(filterBar).gridTemplateColumns.split(' ').length : 0,
      tops: sections.map((element) => Math.round(element.getBoundingClientRect().top)),
    };
  });
  if (ingredientCatalogLayout.columns !== 1) {
    throw new Error(
      `1180x820 食材档案筛选布局异常：${ingredientCatalogLayout.columns} 列/${ingredientCatalogLayout.tops.join(',')}`
    );
  }

  await page.getByRole('button', { name: '库存' }).first().click();
  await expectVisibleText(page, '位置总览', '1180x820 食材库存页');
  await expectNoHorizontalOverflow(page, '1180x820 食材库存页');
  const inventoryColumns = await page.evaluate(() => {
    const grid = document.querySelector('.ingredients-inventory-grid');
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  });
  if (inventoryColumns !== 3) {
    throw new Error(`1180x820 食材库存卡片未保持三列：${inventoryColumns} 列`);
  }

  assertClean();
  await context.close();
}

async function main() {
  assertDistExists();
  const preview = await startPreview();
  const browser = await chromium.launch();
  try {
    await runLoginSmoke(browser, preview.url);
    await runDesktopSmoke(browser, preview.url);
    await runResponsiveSmoke(browser, preview.url, { width: 390, height: 844 }, '390x844');
    await runResponsiveSmoke(browser, preview.url, { width: 768, height: 1024 }, '768x1024');
    await runTabletLandscapeSmoke(browser, preview.url);
    await runTabletAirWorkspaceSmoke(browser, preview.url);
    console.log('Smoke passed: login, desktop workspace tabs, 390x844, 768x1024, 1112x834 and 1180x820 responsive checks.');
  } finally {
    await browser.close();
    await preview.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
