import { hashJson } from '../../src/identity.mjs';

const byte = value => value.toString(16).padStart(2, '0');

// Creation code that copies `runtime`, writes the last `size` bytes of the ABI-encoded constructor argument at runtime offset `at`, and returns the runtime.
function creation(runtime, at, size) {
  const length = runtime.length / 2;
  return `0x60${byte(length)}80601460003960${byte(size)}60${byte(size)}380360${byte(at)}39` + `6000f3${runtime}`;
}

function normalized({ abi, runtime, at, size, id }) {
  const fields = {
    abi,
    bytecode: { object: creation(runtime, at, size), linkReferences: {} },
    deployedBytecode: { object: `0x${runtime}`, linkReferences: {}, immutableReferences: { [id]: [{ start: at, length: size }] } },
    buildIdentity: {},
  };
  return { ...fields, artifactHash: hashJson(fields) };
}

// Holder(address upstream): every call returns the immutable upstream word.
export const holderArtifact = normalized({
  abi: [
    { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'upstream', type: 'address' }] },
    { type: 'function', name: 'UPSTREAM', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  ],
  runtime: `7f${'00'.repeat(32)}60005260206000f3`,
  at: 1,
  size: 32,
  id: '1',
});

// Registry(address owner): setBinding(address) stores slot 0 only when the caller is the immutable owner; any other call returns slot 0.
export const registryArtifact = normalized({
  abi: [
    { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }] },
    { type: 'function', name: 'binding', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
    { type: 'function', name: 'setBinding', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'address' }], outputs: [] },
  ],
  runtime: [
    '36', '6024', '14', '6012', '57', // calldatasize == 36 ? jump set
    '6000', '54', '6000', '52', '6020', '6000', 'f3', // return slot 0
    '5b', `73${'00'.repeat(20)}`, '33', '14', '6031', '57', '6000', '80', 'fd', // set: revert unless caller == owner
    '5b', '6004', '35', '6000', '55', '00', // ok: slot 0 = argument
  ].join(''),
  at: 20,
  size: 20,
  id: '2',
});
