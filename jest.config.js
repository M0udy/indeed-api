/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    '!src/db/**',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
  setupFiles: ['<rootDir>/tests/setup.ts'],
  // ts-jest uses a relaxed tsconfig for tests (noUnusedLocals off for mocks)
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          noUnusedLocals: false,
          noUnusedParameters: false,
          noUncheckedIndexedAccess: false,
        },
      },
    ],
  },
};
