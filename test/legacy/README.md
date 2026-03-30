# test/legacy/

These files are **superseded** and kept for reference only.

- `00-config.test.ts` — config schema tests; replaced by store assertions in `test/automated/`
- `01-e2e-execution.test.ts` — original e2e test; replaced by `test/automated/instance-lifecycle.test.ts`

These files are excluded from `tsconfig.json` and not compiled or run by any active test script.
They can be deleted once the new test battery has been verified on the Pi.
