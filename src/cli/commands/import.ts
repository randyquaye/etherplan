import { acquireLock } from '../../execution/index.ts';
import { prepareResources } from '../../planning/index.ts';
import { importResource, readState, writeStateAtomic } from '../../state/index.ts';
import { verifyResource } from '../../verification/index.ts';
import type { Artifacts } from '../../artifacts/types.ts';
import type { OrderedNode, ParsedSpec } from '../../spec/types.ts';
import type { ChainIdentity, Client, ResourceId } from '../../types.ts';
import type { VerificationResult } from '../../verification/types.ts';
import type { CliOptions } from '../options.ts';
import { print } from '../shared.ts';
import { planningJournal } from '../environment.ts';
import type { ChainCommandContext } from './context.ts';

async function importOne({
  spec,
  ordered,
  artifacts,
  client,
  options,
  stateFile,
}: {
  spec: ParsedSpec;
  ordered: OrderedNode[];
  artifacts: Artifacts;
  client: Client;
  options: CliOptions;
  stateFile: string;
}): Promise<void> {
  if (!options.id?.startsWith('contract:')) throw new Error('import needs --id contract:<name>.');
  const { resources } = prepareResources(spec, ordered, artifacts);
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const selected = byId.get(options.id as ResourceId);
  if (!selected || selected.kind !== 'contract')
    throw new Error(`Unknown contract resource ${options.id}.`);
  const lock = await acquireLock(`${stateFile}.lock`, { planHash: 'import' });
  try {
    const chainId = await client.getChainId();
    if (chainId !== spec.chainId)
      throw new Error(`Connected to chain ${chainId}; spec requires ${spec.chainId}.`);
    const genesis = await client.getBlock({ blockNumber: 0n });
    const observed = await client.getBlock({ blockTag: 'latest' });
    if (!genesis.hash || !observed.hash || observed.number === null)
      throw new Error('Chain block is missing its hash or number.');
    const chain: ChainIdentity = { id: chainId, genesisHash: genesis.hash };
    const current = await readState(stateFile);
    const journalRecords = await planningJournal(stateFile, options);
    const checked = new Map<ResourceId, VerificationResult>();
    async function verifyDependency(id: ResourceId): Promise<VerificationResult> {
      const previous = checked.get(id);
      if (previous) return previous;
      const resource = byId.get(id);
      if (!resource) throw new Error(`Missing dependency ${id}.`);
      for (const dependency of resource.dependencies) await verifyDependency(dependency);
      const verification = await verifyResource(resource, client, {
        blockNumber: observed.number,
        chain,
        journalRecords,
        ...(current?.resources?.[id]?.creationProof
          ? { creationProof: current.resources[id].creationProof }
          : {}),
        ...(id === options.id && options['creation-tx']
          ? { transactionHash: options['creation-tx'] }
          : current?.resources?.[id]?.provenance?.creationTransactionHash
            ? { transactionHash: current.resources[id].provenance.creationTransactionHash }
            : {}),
      });
      if (verification.status !== 'verified')
        throw new Error(
          `Cannot import ${options.id}: ${id} is ${verification.status}. ${[...(verification.reasons ?? []), ...(verification.missingProofs ?? [])].join(' ')}`,
        );
      checked.set(id, verification);
      return verification;
    }
    const verification = await verifyDependency(selected.id);
    if (options['creation-tx'] && verification.evidence?.creation?.status !== 'verified') {
      throw new Error(
        `Creation transaction ${options['creation-tx']} did not prove ${options.id}.`,
      );
    }
    const anchor = await client.getBlock({ blockNumber: observed.number });
    if (anchor.hash !== observed.hash)
      throw new Error('The verification block changed before import. Retry on the current chain.');
    const state = importResource({
      resource: selected,
      verification,
      state: current,
      chain,
      creationTransactionHash: options['creation-tx'] ?? null,
      rebaseline: options.rebaseline ?? false,
    });
    await writeStateAtomic(stateFile, state);
    const record = state.resources[selected.id];
    if (!record) throw new Error(`Imported resource ${selected.id} is missing from state.`);
    const lastRevision = record.artifactRevisions?.at(-1);
    if (options.rebaseline && !lastRevision)
      throw new Error(`Rebaselined resource ${selected.id} has no artifact revision.`);
    print({
      status: options.rebaseline ? 'rebaselined' : 'imported',
      chain,
      id: selected.id,
      address: selected.address,
      codeHash: verification.codeHash,
      proofHash: record.proofHash,
      ...(options.rebaseline
        ? { artifactHash: record.artifactHash, previousArtifactHash: lastRevision?.artifactHash }
        : {}),
      stateFile,
    });
  } finally {
    await lock.release();
  }
}
export async function importCommand(context: ChainCommandContext): Promise<void> {
  const { options } = context;
  if (options.backend) throw new Error('import with a production backend is not yet supported.');
  await importOne(context);
}
