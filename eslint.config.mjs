// Lint rules for every workspace. Formatting is Prettier's job (npm run format:check).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.nx/**', '**/.data/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Test helpers parse untyped JSON-RPC and provider payloads
      '@typescript-eslint/no-explicit-any': 'off',
      // Only config modules read the environment (see AGENTS.md)
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read environment variables only in apps/backend/src/config/env.config.ts',
        },
      ],
    },
  },
  {
    files: ['apps/backend/src/config/**', '**/*.spec.ts', '**/test-support/**', 'scripts/**', '**/jest.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', require: 'readonly', module: 'writable', __dirname: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
