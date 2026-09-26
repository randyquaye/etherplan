import { privateKeyToAccount } from 'viem/accounts';

const keys = (process.env.TEST_DEPLOYER_KEYS ?? '').split(',').filter(Boolean);
const roles = keys.map((_, index) => `deployer-${index + 1}`);
const accounts = new Map(roles.map((role, index) => [role, privateKeyToAccount(keys[index])]));

export const signerRoles = { deployer: roles };
export const signerProvider = {
  async address(role) { return accounts.get(role)?.address; },
  async signTransaction(role, transaction) { return accounts.get(role).signTransaction(transaction); },
};
