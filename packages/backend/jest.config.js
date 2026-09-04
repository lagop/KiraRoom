// Minimal Jest config for unit-tests in packages/backend. Uses ts-jest so
// the existing TypeScript sources can be imported without a build step.
// Only specs of the form `*.spec.ts` are picked up so it never collides
// with the Playwright tests in the project `e2e/` directory.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex: "\\.spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          target: "es2020",
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: false,
          skipLibCheck: true,
        },
      },
    ],
  },
};
