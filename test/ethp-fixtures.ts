import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const labFixture = path.join(root, 'test/fixtures/ethp');

/** Copies the lab .ethp fixture and its JSON lowering into a new directory with the artifacts they name. */
export async function labProject(prefix = 'etherplan-ethp-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const build = JSON.parse(await readFile(path.join(root, 'test/verification-fixtures/sample-build.json'), 'utf8'));
  await Promise.all([
    ...['lab.ethp', 'lab.ethpvars', 'lab.json'].map(name => copyFile(path.join(labFixture, name), path.join(directory, name))),
    copyFile(path.join(root, 'test/fixtures/StateFixture.json'), path.join(directory, 'StateFixture.json')),
    ...['Doubler', 'Linked'].map(name => writeFile(path.join(directory, `${name}.json`), JSON.stringify({ ...build.contracts[name], ast: build.ast }))),
  ]);
  return directory;
}
