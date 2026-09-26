import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for Engine tests.
 *
 * Tests run on compiled JS output in dist-test/ (never dist/, which the live
 * Engine runs from — idea#105). script/test-run.sh compiles into dist-test/
 * before running tests. This keeps the setup simple: no Vite transform pipeline
 * changes, no .js-to-.ts alias tricks for NodeNext module resolution.
 *
 * Tests use real Docker containers and a private per-run mount root
 * (IDEA_DISKS_ROOT) and watch folder (IDEA_WATCH_DIR). They must run
 * sequentially — no parallel execution. pool: 'forks' gives each test file a
 * clean process with no shared state leaking between suites.
 */
export default defineConfig({
    test: {
        environment: 'node',
        // Each test file runs in its own forked process — no shared module state.
        pool: 'forks',
        // Run test files one at a time. Tests share Docker infrastructure (real
        // containers, the per-run mount root) and cannot run concurrently.
        // fileParallelism: false prevents Vitest from running multiple test files
        // at the same time (sequence.concurrent controls within-suite order only).
        fileParallelism: false,
        // Default timeouts. Individual tests override with { timeout: n } option.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // Verbose output matches Mocha's --reporter list behaviour.
        reporters: ['verbose'],
    },
})
