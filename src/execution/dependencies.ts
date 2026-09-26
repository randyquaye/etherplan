// @ts-nocheck
// The executor uses the planner's and verifier's own functions, so apply and plan cannot disagree about a resource.
// Imports are lazy so this module loads before those streams integrate; `override` replaces any function.
const SOURCES = {
  parseSpec: ['../spec/index.ts', 'parseSpec'],
  graph: ['../spec/index.ts', 'graph'],
  prepareResources: ['../planning/index.ts', 'prepareResources'],
  transactionFor: ['../planning/index.ts', 'transactionFor'],
  verifyResource: ['../verification/index.ts', 'verifyResource'],
  readState: ['../state/index.ts', 'readState'],
  writeStateAtomic: ['../state/index.ts', 'writeStateAtomic'],
  recordResource: ['../state/index.ts', 'recordResource'],
};
const OPTIONAL = new Set(['transactionFor', 'recordResource']);

export async function loadDependencies(override = {}) {
  const modules = new Map();
  const loaded = {};
  for (const [name, [specifier, exported]] of Object.entries(SOURCES)) {
    if (override[name]) {
      loaded[name] = override[name];
      continue;
    }
    if (!modules.has(specifier)) {
      modules.set(specifier, await import(specifier).catch(error => {
        if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(specifier.slice(3))) return null;
        throw error;
      }));
    }
    const fn = modules.get(specifier)?.[exported];
    if (typeof fn === 'function') loaded[name] = fn;
    else if (!OPTIONAL.has(name)) throw new Error(`Apply needs ${exported} from src/${specifier.slice(3)}, which is not available.`);
  }
  return loaded;
}
