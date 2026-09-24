#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = await mkdtemp(path.join(os.tmpdir(), 'etherplan-sample-'));

try {
  await mkdir(path.join(workspace, 'src'));
  await cp(path.join(here, 'Sample.sol'), path.join(workspace, 'src/Sample.sol'));
  await writeFile(path.join(workspace, 'foundry.toml'), [
    '[profile.default]',
    "src = 'src'",
    "out = 'out'",
    "solc = '0.8.30'",
    "evm_version = 'prague'",
    'optimizer = true',
    'optimizer_runs = 200',
    'auto_detect_remappings = false',
    'libs = []',
    '',
  ].join('\n'));
  const { stdout: forgeVersion } = await run('forge', ['--version']);
  await run('forge', ['build', '--ast', '--build-info'], { cwd: workspace, maxBuffer: 16 * 1024 * 1024 });
  const contracts = {};
  let ast;
  for (const name of ['Sample', 'Stamped', 'Linked', 'Doubler']) {
    const artifact = JSON.parse(await readFile(path.join(workspace, `out/Sample.sol/${name}.json`), 'utf8'));
    ast = artifact.ast;
    contracts[name] = {
      abi: artifact.abi,
      bytecode: { object: artifact.bytecode.object, linkReferences: artifact.bytecode.linkReferences },
      deployedBytecode: {
        object: artifact.deployedBytecode.object,
        linkReferences: artifact.deployedBytecode.linkReferences,
        ...(artifact.deployedBytecode.immutableReferences ? { immutableReferences: artifact.deployedBytecode.immutableReferences } : {}),
      },
      methodIdentifiers: artifact.methodIdentifiers,
      rawMetadata: artifact.rawMetadata,
      metadata: artifact.metadata,
      id: artifact.id,
    };
  }
  const fixture = {
    toolchain: { forge: forgeVersion.split('\n')[0], solc: contracts.Sample.metadata.compiler.version },
    sourceName: 'src/Sample.sol',
    ast,
    contracts,
  };
  await writeFile(path.join(here, 'sample-build.json'), `${JSON.stringify(fixture)}\n`);
  console.log(JSON.stringify({ written: path.join(here, 'sample-build.json'), toolchain: fixture.toolchain }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
