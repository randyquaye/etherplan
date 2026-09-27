import { encodeAbiParameters, encodeDeployData, encodeFunctionData } from 'viem';
import { isUserAddress } from '../address.ts';
import { assertAbi } from '../artifacts.ts';
import { linkBytecode } from '../verification/bytecode.ts';
import { abiArguments, normalizeOutputs } from '../verification/values.ts';
import type { AbiFunction, AbiParameter } from 'viem';
import type { LinkReferences, NormalizedArtifact } from '../artifacts/types.ts';
import type { PreparedResource } from '../planning/types.ts';
import type { Abi, Address, Hex, JsonValue } from '../types.ts';

type AbiConstructor = Extract<Abi[number], { type: 'constructor' }>;

/** A getter check: PreparedCheck has no `args`; PreparedBinding has them. */
interface CheckInput {
  functionName: string;
  args?: JsonValue[];
  expected: JsonValue;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function withContext<T>(label: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
  }
}

/** A name and argument count must identify exactly one ABI function. */
export function abiFunction(abi: Abi | undefined, name: string, argumentCount: number, label: string): AbiFunction {
  assert(Array.isArray(abi), `${label} needs an ABI for ${name}.`);
  const matches = abi.filter((item): item is AbiFunction => item?.type === 'function' && item.name === name && (item.inputs ?? []).length === argumentCount);
  const [match, ...extra] = matches;
  assert(match !== undefined && extra.length === 0, `${label} has ${matches.length === 0 ? 'no' : 'more than one'} ABI function ${name} with ${argumentCount} argument(s).`);
  return match;
}

function encodedArguments(parameters: readonly AbiParameter[], values: unknown, label: string): unknown[] {
  const args = abiArguments(parameters, values, label);
  encodeAbiParameters(parameters, args);
  return args;
}

function libraryKeys(references: LinkReferences | undefined): string[] {
  return Object.entries(references ?? {}).flatMap(([file, names]) => Object.keys(names).map(name => `${file}:${name}`));
}

function selectedLibraries(references: LinkReferences | undefined, libraries: Record<string, Address>): Record<string, Address> {
  const keys = new Set(libraryKeys(references));
  return Object.fromEntries(Object.entries(libraries).filter(([key]) => keys.has(key)));
}

/** Validate both creation and runtime links, including contracts already on-chain. */
export function validateLibraries(artifact: NormalizedArtifact, libraries: Record<string, Address> = {}, label = 'Contract'): void {
  return withContext(`${label} libraries`, () => {
    const creation = artifact.bytecode?.linkReferences ?? {};
    const runtime = artifact.deployedBytecode?.linkReferences ?? {};
    const required = new Set([...libraryKeys(creation), ...libraryKeys(runtime)]);
    for (const key of required) {
      const address = libraries[key];
      assert(address !== undefined, `Missing linked library ${key}.`);
      assert(isUserAddress(address), `Linked library ${key} has an invalid address or checksum.`);
    }
    for (const key of Object.keys(libraries)) assert(required.has(key), `Unknown linked library ${key}.`);
    linkBytecode(artifact.bytecode.object, creation, selectedLibraries(creation, libraries));
    linkBytecode(artifact.deployedBytecode.object, runtime, selectedLibraries(runtime, libraries));
  });
}

export function encodeConstructor(artifact: NormalizedArtifact, inputs: JsonValue[], libraries: Record<string, Address> = {}, label = 'Contract'): Hex {
  return withContext(`${label} constructor`, () => {
    const constructors = artifact.abi.filter((item): item is AbiConstructor => item?.type === 'constructor');
    assert(constructors.length <= 1, 'Artifact has more than one ABI constructor.');
    const args = encodedArguments(constructors[0]?.inputs ?? [], inputs, 'argument');
    const references = artifact.bytecode.linkReferences ?? {};
    const bytecode = linkBytecode(artifact.bytecode.object, references, selectedLibraries(references, libraries));
    return encodeDeployData({ abi: artifact.abi, bytecode, args });
  });
}

export function encodeMethod(abi: Abi | undefined, method: string, values: JsonValue[], label: string): Hex {
  return withContext(`${label} method ${method}`, () => {
    const fn = abiFunction(abi, method, values.length, label);
    const args = encodedArguments(fn.inputs ?? [], values, 'argument');
    return encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  });
}

function validateCheck(abi: Abi | undefined, check: CheckInput, label: string): AbiFunction {
  return withContext(label, () => {
    const args = check.args ?? [];
    const fn = abiFunction(abi, check.functionName, args.length, label);
    assert(['view', 'pure'].includes(fn.stateMutability), `ABI function ${check.functionName} must be view or pure to be a check.`);
    encodedArguments(fn.inputs ?? [], args, 'argument');
    const outputs = fn.outputs ?? [];
    assert(outputs.length > 0, `ABI function ${check.functionName} has no output to check.`);
    const normalized = normalizeOutputs(outputs, check.expected, `${label} expected`);
    encodedArguments(outputs, outputs.length === 1 ? [normalized] : normalized, 'expected output');
    return fn;
  });
}

/** Synchronous, chain-independent checks for every prepared resource. */
export function validateResources(resources: PreparedResource[]): PreparedResource[] {
  for (const resource of resources) {
    if (resource.kind === 'contract') {
      const artifact = resource.artifact;
      assertAbi(artifact?.abi, resource.id);
      validateLibraries(artifact, resource.libraries ?? {}, resource.id);
      if (resource.initcode !== undefined || resource.inputs.length > 0) {
        encodeConstructor(artifact, resource.inputs, resource.libraries ?? {}, resource.id);
      }
      for (const check of resource.checks ?? []) validateCheck(artifact.abi, check, `${resource.id} check ${check.functionName}`);
      for (const child of resource.createdCode ?? []) {
        const fn = abiFunction(artifact.abi, child.getter, 0, `${resource.id} createdCode`);
        assert(['view', 'pure'].includes(fn.stateMutability) && fn.outputs?.length === 1 && fn.outputs[0]?.type === 'address',
          `${resource.id} createdCode getter ${child.getter} must be view or pure with one address output.`);
      }
    } else if (resource.kind === 'external') {
      if (resource.abi !== undefined) assertAbi(resource.abi, resource.id);
      for (const check of resource.checks ?? []) validateCheck(resource.abi, check, `${resource.id} check ${check.functionName}`);
    } else if (resource.kind === 'call') {
      const abi = resource.abi ?? resource.targetArtifact?.abi;
      const name = resource.after.functionName;
      validateCheck(abi, resource.after, `${resource.id} check ${name} after`);
      validateCheck(abi, resource.before, `${resource.id} check ${name} before`);
      encodeMethod(abi, resource.method, resource.args, resource.id);
    }
  }
  return resources;
}
