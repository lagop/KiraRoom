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
  setupFiles: ["<rootDir>/../jest.setup.js"],
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
          // Transpile each file on its own instead of type-checking it.
          // Type-checking built a TypeScript program per worker over every
          // import (Prisma, Stripe, OpenAI typings...): suites that pull in
          // a large graph spent 80-130 s loading modules for under a second
          // of tests, and a full run on a busy machine pushed some past
          // Jest's 5 s limit. Types are still checked: CI's Type Check job
          // runs tsc over src, specs included (tsconfig.eslint.json).
          isolatedModules: true,
        },
      },
    ],
  },
};
