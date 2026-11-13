/**
 * instance-networks.test.ts — idea#468: prune unused per-instance Docker
 * networks, never frontend/backend, never a network with containers attached.
 * Docker is mocked; nothing talks to a real daemon.
 */
import { describe, it, expect } from 'vitest'
import { fs } from 'zx'
import os from 'os'
import path from 'path'
import {
    SHARED_DOCKER_NETWORKS,
    COMPOSE_PROJECT_LABEL,
    isSharedDockerNetwork,
    pruneUnusedInstanceNetworks,
    pruneUnusedInstanceNetworksForIds,
    composeDownAt,
    type DockerRun,
} from '../../src/utils/instanceNetworks.js'

const recordingRun = (opts: {
    list?: string
    failLs?: boolean
    failRm?: string[]
    /** network id -> container ids that still reference it (running or stopped) */
    users?: Record<string, string>
    failPs?: boolean
} = {}): { run: DockerRun, cmds: string[][] } => {
    const cmds: string[][] = []
    const run: DockerRun = async (args) => {
        cmds.push(args)
        const cmd = args.join(' ')
        if (args[0] === 'network' && args[1] === 'ls') {
            if (opts.failLs) throw new Error('ls failed')
            return opts.list ?? ''
        }
        if (args[0] === 'network' && args[1] === 'rm') {
            const id = args[2]
            if ((opts.failRm ?? []).includes(id)) throw new Error(`Error response from daemon: network ${id} has active endpoints`)
            return id
        }
        if (args[0] === 'ps') {
            if (opts.failPs) throw new Error('ps failed')
            const f = args.find(a => a.startsWith('network='))!.slice('network='.length)
            return opts.users?.[f] ?? ''
        }
        if (args[0] === 'compose') return ''
        throw new Error(`unexpected docker ${cmd}`)
    }
    return { run, cmds }
}

describe('isSharedDockerNetwork (idea#468)', () => {
    it('is only the shared frontend and backend networks', () => {
        expect(SHARED_DOCKER_NETWORKS).toEqual(['frontend', 'backend'])
        expect(isSharedDockerNetwork('frontend')).toBe(true)
        expect(isSharedDockerNetwork('backend')).toBe(true)
        expect(isSharedDockerNetwork('frontend_default')).toBe(false)
        expect(isSharedDockerNetwork('kolibri-abc123_default')).toBe(false)
    })
})

describe('pruneUnusedInstanceNetworks (idea#468)', () => {
    it('lists only unused networks with this compose project label (dangling=true), then rms them', async () => {
        const { run, cmds } = recordingRun({ list: 'aaa\tinst1_default\nbbb\tinst1_internal\n' })
        const r = await pruneUnusedInstanceNetworks('inst1', { run })
        expect(cmds[0]).toEqual([
            'network', 'ls',
            '--filter', `label=${COMPOSE_PROJECT_LABEL}=inst1`,
            '--filter', 'dangling=true',
            '--format', '{{.ID}}\t{{.Name}}',
        ])
        expect(cmds.slice(1)).toEqual([
            ['ps', '-a', '-q', '--filter', 'network=aaa'], ['network', 'rm', 'aaa'],
            ['ps', '-a', '-q', '--filter', 'network=bbb'], ['network', 'rm', 'bbb'],
        ])
        expect(r.removed).toEqual(['inst1_default', 'inst1_internal'])
        expect(r.skipped).toEqual([])
        expect(r.errors).toEqual([])
        // never a host-wide listing or prune: ls is scoped to this project label
        expect(cmds[0].join(' ')).toContain(`label=${COMPOSE_PROJECT_LABEL}=inst1`)
        expect(cmds.some(c => c[1] === 'prune' || (c[0] === 'network' && c[1] === 'ls' && !c.includes(`label=${COMPOSE_PROJECT_LABEL}=inst1`)))).toBe(false)
        for (const c of cmds) {
            expect(c).not.toContain('frontend')
            expect(c).not.toContain('backend')
        }
    })
    it('never removes frontend or backend even if they appear in the list', async () => {
        const { run, cmds } = recordingRun({ list: 'aaa\tfrontend\nbbb\tbackend\nccc\tinst1_default\n' })
        const r = await pruneUnusedInstanceNetworks('inst1', { run })
        expect(r.skipped).toEqual(['frontend', 'backend'])
        expect(r.removed).toEqual(['inst1_default'])
        expect(cmds.filter(c => c[0] === 'network' && c[1] === 'rm').map(c => c[2])).toEqual(['ccc'])
    })
    it('leaves a network that docker refuses to rm (still has containers attached)', async () => {
        const { run, cmds } = recordingRun({ list: 'aaa\tinst1_default\n', failRm: ['aaa'] })
        const r = await pruneUnusedInstanceNetworks('inst1', { run })
        expect(cmds).toContainEqual(['network', 'rm', 'aaa'])
        expect(r.removed).toEqual([])
        expect(r.errors[0]).toMatch(/inst1_default: .*active endpoints/)
    })
    it('leaves a network that a stopped container still references (dangling=true does not see it)', async () => {
        const { run, cmds } = recordingRun({ list: 'aaa\tinst1_default\nbbb\tinst1_stale\n', users: { aaa: 'c0ffee\n' } })
        const r = await pruneUnusedInstanceNetworks('inst1', { run })
        expect(cmds.filter(c => c[0] === 'network' && c[1] === 'rm').map(c => c[2])).toEqual(['bbb'])
        expect(r.skipped).toEqual(['inst1_default'])
        expect(r.removed).toEqual(['inst1_stale'])
    })
    it('a container-check failure leaves the network (fail closed)', async () => {
        const { run, cmds } = recordingRun({ list: 'aaa\tinst1_default\n', failPs: true })
        const r = await pruneUnusedInstanceNetworks('inst1', { run })
        expect(cmds.some(c => c[0] === 'network' && c[1] === 'rm')).toBe(false)
        expect(r.removed).toEqual([])
        expect(r.errors[0]).toMatch(/inst1_default: container check failed: ps failed/)
    })
    it('a listing failure is logged and does not throw; nothing is removed', async () => {
        const { run } = recordingRun({ failLs: true })
        const r = await pruneUnusedInstanceNetworks('inst1', { run })
        expect(r.removed).toEqual([])
        expect(r.errors[0]).toMatch(/ls failed/)
    })
    it('skips docker when IDEA_WATCH_DIR is set and no run is passed', async () => {
        const prev = process.env.IDEA_WATCH_DIR
        process.env.IDEA_WATCH_DIR = prev || '/tmp/idea-test-watch'
        try {
            const r = await pruneUnusedInstanceNetworks('inst1')
            expect(r).toEqual({ removed: [], skipped: [], errors: [] })
        } finally {
            if (prev === undefined) delete process.env.IDEA_WATCH_DIR
            else process.env.IDEA_WATCH_DIR = prev
        }
    })
    it('pruneUnusedInstanceNetworksForIds walks each id', async () => {
        const { run, cmds } = recordingRun({ list: '' })
        await pruneUnusedInstanceNetworksForIds(['a', 'b'], { run })
        expect(cmds.filter(c => c[1] === 'ls')).toHaveLength(2)
        expect(cmds[0]).toContain('label=com.docker.compose.project=a')
        expect(cmds[1]).toContain('label=com.docker.compose.project=b')
    })
    it('does not list or remove anything for an empty id', async () => {
        const { run, cmds } = recordingRun({ list: 'aaa\tnope\n' })
        expect(await pruneUnusedInstanceNetworks('', { run })).toEqual({ removed: [], skipped: [], errors: [] })
        expect(cmds).toEqual([])
    })
})

describe('composeDownAt (idea#424, idea#468)', () => {
    it('runs compose -p -f down on the live file and does not pass -v', async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-down-'))
        try {
            await fs.writeFile(path.join(tmp, 'compose.yaml'), 'services: {}\n')
            const ran: string[][] = []
            await composeDownAt(tmp, 'i1' as any, async (args) => { ran.push(args); return '' })
            expect(ran).toEqual([['compose', '-p', 'i1', '-f', path.join(tmp, 'compose.yaml'), 'down']])
            expect(ran[0].includes('-v') || ran[0].includes('--volumes')).toBe(false)
        } finally { await fs.remove(tmp) }
    })
    it('without compose.yaml does not invent a quarantine glob or call docker compose', async () => {
        const ran: string[][] = []
        await composeDownAt('/no/such/instances/i1', 'i1' as any, async (args) => { ran.push(args); return '' })
        expect(ran).toEqual([])
    })
})
