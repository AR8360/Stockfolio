import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat config covering both workspaces.
 *
 * Type-aware linting is enabled deliberately. The rules worth having in a money
 * application — no floating promises, no unsafe `any` flowing into arithmetic,
 * no misused promises in conditionals — all require type information, and
 * those are exactly the mistakes that produce a wrong number rather than a
 * crash. A syntax-only config would miss every one of them.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in the write path means a transaction that is never
      // awaited and errors that vanish — worth an error, not a warning.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // `any` is permitted only with an explanation, matching CLAUDE.md.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Unused vars are errors, but an underscore prefix marks a deliberate
      // one (unused middleware parameters that must stay for arity).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The dependency-array rule would have flagged nothing in the dropdown
      // bug, but stale closures in the fetch effects are the same class of
      // silent wrongness.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Build-tool configs sit outside both tsconfig projects, so type-aware
    // rules cannot resolve them. Linted for syntax only rather than excluded,
    // so a genuine mistake in them is still caught.
    files: ['**/vite.config.ts', '**/vitest.config.ts', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false, project: null } },
  },

  {
    // Tests construct deliberately malformed values and fake drivers; the
    // strictest type rules fight that without catching real bugs.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // Fakes implement async interfaces without awaiting anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
