import { spawn } from 'node:child_process';
import net from 'node:net';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function startAnvil(arguments_ = []) {
  const port = await reservePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', ['--port', String(port), '--silent', ...arguments_], { stdio: 'ignore' });
  const rpc = async (method, params = []) => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (await rpc('eth_chainId') === '0x7a69') return { child, rpc, rpcUrl };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('Anvil did not start within 10 seconds.');
}

export async function stopAnvil(anvil) {
  if (!anvil?.child || anvil.child.exitCode !== null) return;
  anvil.child.kill('SIGTERM');
  await new Promise(resolve => anvil.child.once('exit', resolve));
}
