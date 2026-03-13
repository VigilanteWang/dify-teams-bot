const js = require('@eslint/js');
const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = [
    {
        ignores: ['node_modules/**', 'deploymentTemplates/**']
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2024
            }
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    },
    eslintConfigPrettier
];
