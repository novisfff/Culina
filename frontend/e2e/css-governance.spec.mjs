import { expect, test } from './fixtures/p0App.mjs';


const GOVERNANCE_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];


export async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    return Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - viewport;
  });
  expect(overflow, 'document 不应产生横向溢出（显式滚动容器除外）').toBeLessThanOrEqual(1);
}


export async function assertInteractiveTargetMinimum(page, minimum = 44) {
  const offenders = await page.evaluate((minimumSize) => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };
    return [...document.querySelectorAll(
      'button.solid-button:not(.button-compact), button.outline-button:not(.button-compact), '
      + 'button.ghost-button:not(.button-compact), .mobile-bottom-nav button, .sidebar-nav button, '
      + 'a[href], input, select, textarea',
    )]
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60) || element.tagName,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        };
      })
      .filter(({ width, height }) => width < minimumSize || height < minimumSize);
  }, minimum);
  expect(offenders, `每个独立交互目标应至少 ${minimum}×${minimum}px`).toEqual([]);
}


export async function assertOverlayFocusContract(page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]:visible').last();
  await expect(dialog, 'overlay 应存在可见 dialog').toBeVisible();
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  expect(labelledBy, 'overlay 应通过 aria-labelledby 关联标题').toBeTruthy();
  await expect(page.locator(`#${labelledBy}`), 'aria-labelledby 目标应存在').toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  if (await dialog.getAttribute('data-workspace-overlay-busy') === 'true') {
    await page.keyboard.press('Escape');
    await expect(dialog, 'busy overlay 不应被 Escape 关闭').toBeVisible();
  }
}


test('CSS governance assertions reject overflow, undersized targets, and broken busy overlay fixtures', async ({ page }) => {
  await page.setContent(`
    <main style="width: calc(100vw + 1px)"><button id="trigger">打开</button></main>
  `);
  await expect(assertNoHorizontalOverflow(page)).rejects.toThrow();

  await page.setContent('<button class="solid-button" style="width:43px;height:44px">关闭</button>');
  await expect(assertInteractiveTargetMinimum(page)).rejects.toThrow();

  await page.setContent(`
    <button id="trigger">打开弹层</button>
    <div role="dialog" aria-modal="true" aria-labelledby="fixture-title" data-workspace-overlay-busy="true">
      <h2 id="fixture-title">处理中</h2><button id="close">关闭</button>
    </div>
  `);
  await page.locator('#close').focus();
  await assertOverlayFocusContract(page);
});


test('Home, Ingredients, Food, Eat, AI, and Family stay within governance contracts across fixed viewports', async ({ app }) => {
  const { page } = app;
  for (const viewport of GOVERNANCE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertInteractiveTargetMinimum(page);

    const nav = (name) => page.locator(
      '.mobile-bottom-nav:visible, .sidebar-nav:visible, .tabbar:visible',
    ).getByRole('button', { name, exact: true }).first();
    const resetHome = async () => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: '今天吃什么' })).toBeVisible();
    };
    await nav('食材').click();
    await expect(page.getByRole('heading', { name: '食材' })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await resetHome();
    await nav('吃什么').click();
    await expect(page.getByRole('heading', { name: '吃什么' })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await resetHome();
    await nav('AI').click();
    await expect(page.locator('.ai-mobile-page:visible, .ai-desktop-view:visible').getByText('AI 厨房助手', { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await resetHome();
    await nav('家庭').click();
    await expect(page.locator('.family-desktop-view:visible, .mobile-family-page:visible').getByRole('heading').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  }
});
