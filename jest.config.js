/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  setupFiles: ["<rootDir>/tests/jestEnv.js"],
  transform: {},
  moduleFileExtensions: ["js", "mjs"],
  testPathIgnorePatterns: ["/node_modules/"],
};

export default config;
