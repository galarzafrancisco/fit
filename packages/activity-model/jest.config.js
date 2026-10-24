module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node10', strict: true, types: ['jest', 'node'] } }] },
};
