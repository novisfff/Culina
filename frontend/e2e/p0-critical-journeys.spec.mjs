import { expect, test } from './fixtures/p0App.mjs';

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  );
  expect(overflow, '页面不应产生横向溢出').toBeLessThanOrEqual(1);
}

async function attachCheckpointScreenshot(page, testInfo, name) {
  await testInfo.attach(name, {
    body: await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
    }),
    contentType: 'image/png',
  });
}

async function stabilizeDarwinVisualGutter(page) {
  if (process.platform === 'darwin') {
    await page.addStyleTag({ content: 'html { scrollbar-gutter: auto !important; }' });
  }
}

test.describe('P0 unauthenticated entry', () => {
  test.use({ authenticated: false });

  test('@p0 renders the family-kitchen login entry', async ({ app }, testInfo) => {
    const { page } = app;

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: '登录家庭厨房' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入家庭厨房' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await stabilizeDarwinVisualGutter(page);
    await expect(page.locator('.login-card')).toHaveScreenshot('login-card.png');
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-login-entry');
  });
});

test.describe('P0 authenticated family workflow', () => {
  test('@p0 opens food, ingredient, meal-history, and meal-recording surfaces', async ({ app }, testInfo) => {
    const { page, requestedApiPaths } = app;
    const isPhone = testInfo.project.name === 'phone-375x812';

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const homeSurface = page.locator(isPhone ? '.mobile-dashboard-page' : '.dashboard-page');
    await expect(homeSurface.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    await expect(homeSurface.getByRole('heading', { name: '今天必须处理什么' })).toBeVisible();
    await expect(homeSurface.getByRole('heading', { name: '家里发生了什么' })).toBeVisible();
    await expect
      .poll(() => requestedApiPaths.includes('/api/activity-highlights'))
      .toBe(true);
    expect(requestedApiPaths).not.toContain('/api/activity-logs');
    await expectNoHorizontalOverflow(page);
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-family-home');

    await page.getByRole('button', { name: '吃什么' }).first().click();
    if (isPhone) {
      await expect(page.locator('.mobile-food-page')).toBeVisible();
      await expect(page.locator('.mobile-food-page').getByRole('heading', { name: '吃什么' })).toBeVisible();
    } else {
      await expect(page.getByText('食物库', { exact: true }).first()).toBeVisible();
    }

    await page.getByRole('button', { name: '食材' }).first().click();
    if (isPhone) {
      await expect(page.locator('.mobile-ingredient-page')).toBeVisible();
      await expect(page.locator('.mobile-ingredient-page').getByRole('heading', { name: '食材' })).toBeVisible();
    } else {
      await expect(page.getByText('管理家庭食材档案、库存状态以及采购清单。', { exact: true })).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-ingredient-page');

    await page.getByRole('button', { name: '吃什么' }).first().click();
    if (isPhone) {
      await page.locator('.food-mobile-view').getByRole('button', { name: '吃过的' }).click();
      await expect(page.locator('.mobile-log-page')).toBeVisible();
      await page.locator('.mobile-log-primary-cta').click();
    } else {
      await page.locator('.food-workspace .hero-actions').getByRole('button', { name: '吃过的' }).click();
      await expect(page.getByText('家庭时间线', { exact: true })).toBeVisible();
      await page.locator('.meal-log-header-actions').getByRole('button', { name: '记一餐' }).click();
    }

    const mealComposer = page.locator('.meal-composer-modal');
    await expect(mealComposer).toBeVisible();
    await expect(mealComposer.getByRole('heading', { name: '确认时间' })).toBeVisible();
    await expect(mealComposer.getByRole('heading', { name: '添加食物' })).toBeVisible();
    await attachCheckpointScreenshot(page, testInfo, 'checkpoint-meal-composer');

    const foodSearch = mealComposer.getByRole('searchbox', { name: '搜索食物' });
    await foodSearch.fill('番茄');
    await expect(mealComposer.getByRole('listbox', { name: '食物搜索结果' })).toBeVisible();
    await foodSearch.clear();
    await expect(mealComposer.locator('.meal-composer-date-strip')).toBeVisible();

    await mealComposer.getByLabel('关闭弹窗').click();
    await expect(mealComposer).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
