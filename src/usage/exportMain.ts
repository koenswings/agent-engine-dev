/**
 * TypeScript CLI entry for the export verbs (idea#411). Used by unit tests and
 * `runExport` in this process. The binary installed at
 * `/usr/local/sbin/idea-usage-export` (sshd `command=`, helper v7 / idea#412)
 * is `script/build_image_assets/idea-usage-export` (standalone Python), not
 * this file. Both must match `test/fixtures/usage-export-parity/` goldens.
 */
import { runExport } from './exportCmd.js'

const code = await runExport({
    argv: process.argv.slice(2),
    sshOriginal: process.env.SSH_ORIGINAL_COMMAND,
    stdout: process.stdout,
    stderr: process.stderr,
})
process.exit(code)
