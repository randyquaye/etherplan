import { spawn } from 'node:child_process';
import net from 'node:net';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { holderArtifact, registryArtifact } from './contracts.mjs';

// Anvil's published development keys. They hold value only on a local test chain.
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
];
export const TEST_KEYS = KEYS;
export const accounts = KEYS.map(key => privateKeyToAccount(key));
export const [deployerA, deployerB, spare, owner, outsider] = accounts;
export const ZERO = '0x0000000000000000000000000000000000000000';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts a private Anvil on an ephemeral port. It never uses the shared test chain.
export async function startAnvil(args = []) {
  const port = await freePort();
  const child = spawn('anvil', ['--port', String(port), '--silent', ...args], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url) });
  for (let attempt = 0; ; attempt++) {
    try {
      await client.getChainId();
      break;
    } catch (error) {
      if (attempt > 100 || child.exitCode !== null) {
        child.kill('SIGKILL');
        throw new Error(`anvil did not start on port ${port}: ${error.message}`);
      }
      await sleep(100);
    }
  }
  return {
    url,
    client,
    rpc: (method, params = []) => client.request({ method, params }),
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    }),
  };
}

const salt = digit => `0x${digit.repeat(64)}`;

// Four CREATE2 contracts and one owner call. alpha, beta, and registry are independent; gamma needs alpha; the call needs gamma and registry.
export function fixture({ upstream = '0x0000000000000000000000000000000000000001', withCall = true } = {}) {
  const spec = {
    schema: 1,
    chainId: 31337,
    values: { upstream, other: '0x0000000000000000000000000000000000000002', owner: owner.address, zero: ZERO },
    contracts: [
      { id: 'alpha', artifact: 'Holder.json', salt: salt('a'), args: [{ ref: 'values.upstream' }], checks: { UPSTREAM: { ref: 'values.upstream' } }, senderIndependent: true },
      { id: 'beta', artifact: 'Holder.json', salt: salt('b'), args: [{ ref: 'values.other' }], checks: { UPSTREAM: { ref: 'values.other' } }, senderIndependent: true },
      { id: 'registry', artifact: 'Registry.json', salt: salt('c'), args: [{ ref: 'values.owner' }], senderIndependent: true },
      { id: 'gamma', artifact: 'Holder.json', salt: salt('d'), args: [{ ref: 'contracts.alpha.address' }], checks: { UPSTREAM: { ref: 'contracts.alpha.address' } }, senderIndependent: true },
    ],
    calls: [
      { id: 'bindGamma', target: 'registry', method: 'setBinding', args: [{ ref: 'contracts.gamma.address' }], check: { function: 'binding', equals: { ref: 'contracts.gamma.address' } }, before: { equals: { ref: 'values.zero' } } },
    ],
  };
  if (!withCall) spec.calls = [];
  const artifacts = new Map([['alpha', holderArtifact], ['beta', holderArtifact], ['registry', registryArtifact], ['gamma', holderArtifact]]);
  return { spec, artifacts };
}
