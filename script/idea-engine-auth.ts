/**
 * idea-engine-auth — local operator accounts on this Pi (engine#582).
 *
 *   node dist/script/idea-engine-auth.js list
 *   node dist/script/idea-engine-auth.js set-password <username>
 *
 * set-password creates the operator or replaces its password. The password is read
 * from the terminal without echo (twice), or as one line from stdin when piped. It
 * is hashed here with bcrypt (cost 10) and only the hash is written to
 * <authFolder>/operators.json. Run it as the user the Engine runs as (pi), so the
 * auth folder keeps its owner. With an operator present, the Engine's setup code is
 * no longer needed (restart the Engine to close setup).
 */

import bcrypt from 'bcryptjs'
import { authFolder } from '../src/data/Config.js'
import { listOperators, upsertOperatorHash, validUsername } from '../src/data/Operators.js'

const out = (s: string): void => { process.stdout.write(s + '\n') }
const fail = (s: string): never => { process.stderr.write(s + '\n'); process.exit(1) }

const readHidden = (prompt: string): Promise<string> => new Promise((resolve) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
        const chunks: Buffer[] = []
        stdin.on('data', (c: Buffer) => chunks.push(c))
        stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? ''))
        stdin.resume()
        return
    }
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const onData = (d: Buffer) => {
        for (const ch of d.toString('utf8')) {
            if (ch === '\r' || ch === '\n') {
                stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData)
                process.stdout.write('\n'); resolve(buf); return
            }
            if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130) }
            if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
            else buf += ch
        }
    }
    stdin.on('data', onData)
})

const main = async (): Promise<void> => {
    const [cmd, username] = process.argv.slice(2)
    if (cmd === 'list') {
        const ops = listOperators()
        out(`Auth folder: ${authFolder()}`)
        if (!ops.length) out('No operators yet (the Engine shows a setup code).')
        for (const o of ops) out(`${o.username}\t${o.id}\tcreated ${new Date(o.created).toISOString()}`)
        return
    }
    if (cmd === 'set-password') {
        if (!validUsername(username)) fail('Usage: idea-engine-auth set-password <username>')
        const p1 = await readHidden(`New password for ${username}: `)
        if (p1.length < 8) fail('The password must have at least 8 characters.')
        if (process.stdin.isTTY) {
            const p2 = await readHidden('Repeat it: ')
            if (p1 !== p2) fail('The passwords differ. Nothing changed.')
        }
        const hash = bcrypt.hashSync(p1, 10)
        const what = upsertOperatorHash(username, hash)
        out(`Operator '${username}' ${what} in ${authFolder()}.`)
        return
    }
    fail('Usage: idea-engine-auth list | set-password <username>')
}

main().catch((e) => fail(`idea-engine-auth: ${e?.message ?? e}`))
