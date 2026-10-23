const { compilerOptions } = require('./tsconfig.json');

module.exports = {
  moduleFileExtensions: ['js', 'mjs', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  testEnvironment: 'node',
  // PGlite boots a WASM Postgres per test file
  testTimeout: 60000,
  transform: {
    '^.+\\.(t|j|mj)s$': [
      'ts-jest',
      {
        // @taico/auth, jose and the MCP SDK ship ESM, so their JavaScript is transformed too
        tsconfig: { ...compilerOptions, module: 'commonjs', moduleResolution: 'node10', resolvePackageJsonExports: false, allowJs: true, isolatedModules: true, incremental: false },
        diagnostics: { ignoreCodes: ['TS151001'] },
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!(@modelcontextprotocol|jose|@taico|pkce-challenge)/)'],
};
