import { $, echo, argv, cd, chalk, fs, question } from 'zx'
import { ssh } from '../src/utils/ssh.js'
import pack from '../package.json' with { type: "json" }

const p = $`dmesg -wH | grep --line-buffered "Attached SCSI disk"`
for await (const chunk of p.stdout) {
  echo(chunk)
}

console.log("Done")
