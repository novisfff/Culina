import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installApiMocks } from '../e2e/fixtures/apiMocks.mjs';

async function mockSession() {
  const handlers = new Map();
  const unexpectedRequests = [];
  await installApiMocks({ route: async (pattern, handler) => handlers.set(pattern, handler) }, unexpectedRequests);
  return {
    unexpectedRequests,
    async request(method, pathname, body) {
      let response;
      await handlers.get('**/api/**')({
        request: () => ({
          method: () => method,
          url: () => `http://127.0.0.1:4174${pathname}`,
          postDataJSON: () => body,
          headers: () => ({}),
        }),
        fulfill: async (value) => { response = value; },
      });
      return { status: response.status, body: JSON.parse(response.body) };
    },
  };
}

describe('P0 API mock module boundary', () => {
  it('can be imported without side effects and exports its installer', () => {
    const fixtureUrl = pathToFileURL(
      resolve(process.cwd(), 'e2e/fixtures/apiMocks.mjs'),
    ).href;
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const module = await import(${JSON.stringify(fixtureUrl)});
         process.exit(typeof module.installApiMocks === 'function' ? 0 : 2);`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.error, `${probe.stdout}\n${probe.stderr}`).toBeUndefined();
    expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
  });

  it('makes a recorded meal readable without leaking it to another browser context', async () => {
    const session = await mockSession();
    const result = await session.request('POST', '/api/meal-logs/record', {
      client_request_id: 'p0-record-probe', date: '2026-07-12', meal_type: 'breakfast',
      target: { kind: 'new' }, entries: [{ food_id: 'food-egg', servings: 1 }],
    });
    expect(result.status).toBe(200);
    const saved = (await session.request('GET', '/api/meal-logs')).body;
    expect(saved.filter((meal) => meal.id === result.body.meal_log.id)).toEqual([result.body.meal_log]);
    const independent = await mockSession();
    expect((await independent.request('GET', '/api/meal-logs')).body.map((meal) => meal.id))
      .not.toContain(result.body.meal_log.id);
  });

  it.each(['/api/__missing__', '/api/family/model-settings/__missing__'])(
    'records an unhandled request to %s for fixture teardown', async (pathname) => {
      const session = await mockSession();
      expect((await session.request('GET', pathname)).status).toBe(404);
      expect(session.unexpectedRequests).toEqual([`GET ${pathname}`]);
    },
  );
});
