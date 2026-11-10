/**
 * CLI entry for idea-usage-export (idea#411). Helper v8 (idea#412) installs
 * the root-owned forced-command binary that invokes this compiled file.
 */
import { runExport } from './exportCmd.js'

const code = await runExport({
    argv: process.argv.slice(2),
    sshOriginal: process.env.SSH_ORIGINAL_COMMAND,
    stdout: process.stdout,
    stderr: process.stderr,
})
process.exit(code)
