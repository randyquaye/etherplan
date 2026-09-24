// The executor uses the planner's and verifier's own functions, so apply and plan cannot disagree about a resource.
// Imports are lazy so this module loads before those streams integrate; `override` replaces any function.
const SOURCES = {
  parseSpec: ['../spec/index.mjs', 'parseSpec'],
  graph: ['../spec/index.mjs', 'graph'],
  prepareResources: ['../planning/index.mjs', 'prepareResources'],
  transactionFor: ['../planning/index.mjs', 'transactionFor'],
  verifyResource: ['../verification/index.mjs', 'verifyResource'],
  readState: ['../state/index.mjs', 'readState'],
  writeStateAtomic: ['../state/index.mjs', 'writeStateAtomic'],
  recordResource: ['../state/index.mjs', 'recordResource'],
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
