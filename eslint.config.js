import tseslint from 'typescript-eslint';

// The package's TypeScript 6 alias supplies the compiler API for typed linting.
// Build and typecheck continue to use the native TypeScript 7 tsc binary.
export default [
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // node:test registers and handles these calls; the tests also use async HTTP listeners.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'before', 'after', 'describe', 'it'], package: 'node:test' }],
      }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    },
  },
];
