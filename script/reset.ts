import { $, argv, cd, chalk, fs, question } from 'zx'
import { ssh } from '../src/utils/ssh.js'
import pack from '../package.json' with { type: "json" }
import { reset } from '../src/utils/utils.js'

// Add commandline option to print the version of the script
const { version } = pack
if (argv.v || argv.version) {
  console.log(`Version: ${version}`);
  process.exit(0);
}

// Add commandline option to print the help of the script
if (argv.h || argv.help) {
  console.log(`
  Usage: ./reset.ts [options]
  
  Options:
    -v, --version                Print the version
    -h, --help                   Print the help
  `);
  process.exit(0);
}

await reset($)
