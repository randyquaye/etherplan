import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the package exposes only its root library entry', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, unknown> };
  assert.deepEqual(Object.keys(manifest.exports), ['.']);

  const api = await import('etherplan');
  assert.equal(typeof api.applyPlan, 'function');
  await assert.rejects(import('etherplan/src/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
