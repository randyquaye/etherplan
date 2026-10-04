import { readState, validateState } from '../../state/index.ts';
import type { StateFile } from '../../state/types.ts';
import type { Address } from '../../types.ts';
import { backendFromFile, publicClient } from '../environment.ts';
import type { CliOptions } from '../options.ts';
import { print } from '../shared.ts';

async function storedState(options: CliOptions, stateFile: string): Promise<StateFile | null> {
  if (!options.backend) return readState(stateFile);
  if (!process.env.ETH_RPC_URL) throw new Error('Set ETH_RPC_URL for output --backend.');
  const client = publicClient();
  const id = await client.getChainId();
  const genesis = await client.getBlock({ blockNumber: 0n });
  const chain = { id, genesisHash: genesis.hash };
  const backend = await backendFromFile(options.backend, chain);
  const stored = (await backend.stateStore.read(backend.scope))?.value;
  const state = stored == null ? null : validateState(stored);
  if (
    state &&
    (state.chain.id !== id || state.chain.genesisHash.toLowerCase() !== genesis.hash.toLowerCase())
  ) {
    throw new Error('Stored state belongs to a different chain.');
  }
  return state;
}

export async function output(options: CliOptions, stateFile: string): Promise<void> {
  const state = await storedState(options, stateFile);
  if (!state)
    throw new Error(
      `No state found${options.backend ? ' in the backend' : ` at ${stateFile}`}. Run apply or import first.`,
    );
  const addresses: Record<string, Address> = {};
  for (const [id, resource] of Object.entries(state.resources).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (id.startsWith('contract:') || id.startsWith('external:')) addresses[id] = resource.address;
  }
  if (options.id) {
    const address = addresses[options.id];
    if (!address) throw new Error(`State has no address for ${options.id}.`);
    print({ formatVersion: 1, chain: state.chain, addresses: { [options.id]: address } });
  } else {
    print({ formatVersion: 1, chain: state.chain, addresses });
  }
}
