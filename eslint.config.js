const js = require('@eslint/js');
const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

// Flat Config 写法：按数组顺序合并配置，后面的配置可覆盖前面的同名项。
module.exports = [
    {
        // 忽略无需 lint 的目录，减少扫描时间和噪音告警。
        ignores: ['node_modules/**', 'deploymentTemplates/**']
    },
    // ESLint 官方 JS 推荐规则集。
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            // 使用最新 ECMAScript 语法，并按 CommonJS（require/module.exports）解析。
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                // 注入 Node.js 与 ES2024 的全局变量，避免误报“未定义”。
                ...globals.node,
                ...globals.es2024
            }
        },
        rules: {
            // 未使用变量视为错误；但形如 _xxx 的参数通常是“占位参数”，允许忽略。
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
        }
    },
    // 关闭与 Prettier 冲突的格式化规则，避免同一代码被两套工具反复拉扯。
    eslintConfigPrettier
];
