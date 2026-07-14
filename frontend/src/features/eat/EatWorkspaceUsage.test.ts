import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('EatWorkspace desktop layout', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('keeps the embedded discovery surface in the document scroll flow', () => {
    const styles = readFileSync(resolve(repoRoot, 'src/styles/12-eat-workspace.css'), 'utf8');

    expect(styles).toContain('.app-frame:has(.eat-workspace .food-content-layout)');
    expect(styles).toContain('.app-content:has(.eat-workspace .food-content-layout)');
    expect(styles).toContain('.eat-workspace .food-content-layout');
    expect(styles).toContain('height: auto;');
    expect(styles).toContain('overflow: visible;');
  });

  it('keeps focused task overlays above discovery card media', () => {
    const styles = readFileSync(resolve(repoRoot, 'src/styles/12-eat-workspace.css'), 'utf8');
    const taskLayerRule = styles.match(
      /\.eat-task-overlay,\s*\.eat-recipe-task-body,\s*\.eat-cook-task-body\s*\{([^}]*)\}/,
    );

    expect(taskLayerRule?.[1]).toContain('z-index: 4;');
  });

  it('restores the immersive cook shell without primary navigation', () => {
    const styles = readFileSync(resolve(repoRoot, 'src/styles/12-eat-workspace.css'), 'utf8');
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(styles).toContain('.eat-workspace-cook-mode .eat-cook-task-body');
    expect(overlayStyles).toContain('.app-frame:has(.recipe-workspace-cook-mode) .sidebar-shell');
    expect(overlayStyles).toContain('.app-frame:has(.recipe-workspace-cook-mode) .tabbar');
  });
});
