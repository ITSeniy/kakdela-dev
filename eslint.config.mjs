import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/polly/src-tauri/**',
      'packages/polly/gen/**',
      'designs/**',
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ['packages/speedy/src/routes/{auth,messages,files,keys,secret-chat}.ts', 'packages/speedy/src/lib/{link-preview,auto-delete}.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // React-правила для клиентского кода (polly) — включая .ts с хуками,
  // чтобы существующие eslint-disable-next-line react-hooks/* были валидны.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    rules: {
      // _префикс — осознанно неиспользуемое.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
    },
  },
)
