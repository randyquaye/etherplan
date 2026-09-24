import { encodeAbiParameters, encodeDeployData, encodeFunctionData, isAddress } from 'viem';
import { assertAbi } from '../artifacts.mjs';
import { linkBytecode } from '../verification/bytecode.mjs';
import { abiArguments, normalizeOutputs } from '../verification/values.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withContext(label, work) {
  try {
    return work();
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
}

/** A name and argument count must identify exactly one ABI function. */
export function abiFunction(abi, name, argumentCount, label) {
  assert(Array.isArray(abi), `${label} needs an ABI for ${name}.`);
  const matches = abi.filter(item => item?.type === 'function' && item.name === name && (item.inputs ?? []).length === argumentCount);
  assert(matches.length === 1, `${label} has ${matches.length === 0 ? 'no' : 'more than one'} ABI function ${name} with ${argumentCount} argument(s).`);
  return matches[0];
}

function encodedArguments(parameters, values, label) {
  const args = abiArguments(parameters, values, label);
  encodeAbiParameters(parameters, args);
  return args;
}

function libraryKeys(references) {
  return Object.entries(references ?? {}).flatMap(([file, names]) => Object.keys(names).map(name => `${file}:${name}`));
}

function selectedLibraries(references, libraries) {
  return Object.fromEntries(libraryKeys(references).filter(key => Object.hasOwn(libraries, key)).map(key => [key, libraries[key]]));
}

/** Validate both creation and runtime links, including contracts already on-chain. */
export function validateLibraries(artifact, libraries = {}, label = 'Contract') {
  return withContext(`${label} libraries`, () => {
    const creation = artifact.bytecode?.linkReferences ?? {};
    const runtime = artifact.deployedBytecode?.linkReferences ?? {};
    const required = new Set([...libraryKeys(creation), ...libraryKeys(runtime)]);
    for (const key of required) assert(isAddress(libraries[key], { strict: false }), `Missing linked library ${key}.`);
    for (const key of Object.keys(libraries)) assert(required.has(key), `Unknown linked library ${key}.`);
    linkBytecode(artifact.bytecode.object, creation, selectedLibraries(creation, libraries));
    linkBytecode(artifact.deployedBytecode.object, runtime, selectedLibraries(runtime, libraries));
  });
}

export function encodeConstructor(artifact, inputs, libraries = {}, label = 'Contract') {
  return withContext(`${label} constructor`, () => {
    const constructors = artifact.abi.filter(item => item?.type === 'constructor');
    assert(constructors.length <= 1, 'Artifact has more than one ABI constructor.');
    const args = encodedArguments(constructors[0]?.inputs ?? [], inputs, 'argument');
    const references = artifact.bytecode.linkReferences ?? {};
    const bytecode = linkBytecode(artifact.bytecode.object, references, selectedLibraries(references, libraries));
    return encodeDeployData({ abi: artifact.abi, bytecode, args });
  });
}

export function encodeMethod(abi, method, values, label) {
  return withContext(`${label} method ${method}`, () => {
    const fn = abiFunction(abi, method, values.length, label);
    const args = encodedArguments(fn.inputs ?? [], values, 'argument');
    return encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  });
}

function validateCheck(abi, check, label) {
  return withContext(label, () => {
    const args = check.args ?? [];
    const fn = abiFunction(abi, check.functionName, args.length, label);
    encodedArguments(fn.inputs ?? [], args, 'argument');
    const outputs = fn.outputs ?? [];
    assert(outputs.length > 0, `ABI function ${check.functionName} has no output to check.`);
    const normalized = normalizeOutputs(outputs, check.expected, `${label} expected`);
    encodedArguments(outputs, outputs.length === 1 ? [normalized] : normalized, 'expected output');
    return fn;
  });
}

/** Synchronous, chain-independent checks for every prepared resource. */
export function validateResources(resources) {
  for (const resource of resources) {
    if (resource.kind === 'contract') {
      const artifact = resource.artifact;
      assertAbi(artifact?.abi, resource.id);
      validateLibraries(artifact, resource.libraries ?? {}, resource.id);
      if (resource.initcode !== undefined || resource.inputs.length > 0) {
        encodeConstructor(artifact, resource.inputs, resource.libraries ?? {}, resource.id);
      }
      for (const check of resource.checks ?? []) validateCheck(artifact.abi, check, `${resource.id} check ${check.functionName}`);
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
