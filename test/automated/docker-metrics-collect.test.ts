/**
 * docker-metrics-collect.test.ts (idea#492)
 *
 * collectMetrics attributes containers only when com.docker.compose.project
 * equals composeProjectName(instanceId). A fake docker on PATH answers
 * `docker ps` and `docker stats`. Overlapping stacks get separate metrics,
 * a dotted id is credited to that id (not the live prefix), unlabeled
 * containers are not counted, and metricsMessage shape is unchanged.
 */
import { describe, it, afterEach, expect } from 'vitest'
import * as os from 'os'
import { fs, path } from 'zx'
import {
    collectMetrics, metricsMessage,
} from '../../src/monitors/dockerMetricsMonitor.js'
import { composeProjectName } from '../../src/utils/instanceIds.js'
import { METRICS_TYPE } from '../../src/data/Liveness.js'
import type { DockerMetrics } from '../../src/data/CommonTypes.js'

const LIVE = 'nextcloud-yj8ral61js46bphogbi'
const DOTTED = 'nextcloud-yj8ral61js46bphogbi.backup-20261027-181633'
const BAK_PROJECT = composeProjectName(DOTTED)
const A = 'kolibri-a'
const AB = 'kolibri-ab'

const LIVE_C = `${LIVE}-nextcloud-1`
const BAK_C = `${BAK_PROJECT}-nextcloud-1`
const A_C = `${A}-app-1`
const AB_C = `${AB}-app-1`
const UNLABELED = `${LIVE}-orphan-1`

const statsLine = (name: string, cpu: string, mem = '256MiB / 1GiB', memP = '25.00%', net = '1.00kB / 2.00kB', block = '10.00MB / 5.00MB') =>
    JSON.stringify({ Name: name, CPUPerc: cpu, MemUsage: mem, MemPerc: memP, NetIO: net, BlockIO: block })

const METRIC_KEYS = [
    'cpuPercent', 'memUsageBytes', 'memLimitBytes', 'memPercent',
    'netRxBytes', 'netTxBytes', 'blockReadBytes', 'blockWriteBytes', 'sampledAt',
] as const

let dir: string
let savedPath: string

const writeFakeDocker = async (ps: string, stats: Record<string, string>) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-492-fake-docker-'))
    const bin = path.join(dir, 'bin')
    await fs.ensureDir(bin)
    await fs.writeFile(path.join(dir, 'ps.out'), ps)
    await fs.writeFile(path.join(dir, 'stats.tsv'), Object.entries(stats).map(([n, j]) => `${n}\t${j}`).join('\n') + '\n')
    await fs.writeFile(path.join(dir, 'calls.log'), '')
    const script = `#!/usr/bin/env bash
set -euo pipefail
echo "$@" >> "${dir}/calls.log"
case "\${1-}" in
  ps)
    cat "${dir}/ps.out"
    ;;
  stats)
    shift
    names=()
    while [ \$# -gt 0 ]; do
      case "\$1" in
        --no-stream) shift ;;
        --format) shift; [ \$# -gt 0 ] && shift ;;
        *) names+=("\$1"); shift ;;
      esac
    done
    for n in "\${names[@]}"; do
      awk -F '\\t' -v n="\$n" '\$1==n { print substr(\$0, index(\$0, \$2)); found=1 } END { exit found?0:1 }' "${dir}/stats.tsv"
    done
    ;;
  *)
    echo "unexpected docker argv: \$*" >&2
    exit 1
    ;;
esac
`
    await fs.writeFile(path.join(bin, 'docker'), script, { mode: 0o755 })
    savedPath = process.env.PATH ?? ''
    process.env.PATH = `${bin}:${savedPath}`
}

const readCalls = async (): Promise<string[]> =>
    (await fs.readFile(path.join(dir, 'calls.log'), 'utf8')).split('\n').map(l => l.trim()).filter(Boolean)

describe('collectMetrics exact compose-project attribution (idea#492)', () => {
    afterEach(async () => {
        if (savedPath !== undefined) process.env.PATH = savedPath
        if (dir) await fs.remove(dir)
    })

    it('overlapping stacks get separate metrics; a dotted id is credited correctly; unlabeled containers are not counted', async () => {
        expect(BAK_PROJECT).toBe('nextcloud-yj8ral61js46bphogbibackup-20261027-181633')
        expect(BAK_C.startsWith(LIVE)).toBe(true)
        expect(UNLABELED.startsWith(LIVE)).toBe(true)

        const ps = [
            `${A_C}\t${A}`,
            `${AB_C}\t${AB}`,
            `${LIVE_C}\t${LIVE}`,
            `${BAK_C}\t${BAK_PROJECT}`,
            UNLABELED,                    // no project label
            `${LIVE}-also-1\t`,           // empty project label
        ].join('\n') + '\n'

        await writeFakeDocker(ps, {
            [A_C]:    statsLine(A_C, '10.00%'),
            [AB_C]:   statsLine(AB_C, '20.00%'),
            [LIVE_C]: statsLine(LIVE_C, '11.00%'),
            [BAK_C]:  statsLine(BAK_C, '22.00%'),
            [UNLABELED]: statsLine(UNLABELED, '99.00%'),
        })

        const ids = [A, AB, LIVE, DOTTED]
        const { metrics, runningContainers } = await collectMetrics(ids)

        expect(runningContainers?.sort()).toEqual([A_C, AB_C, BAK_C, LIVE_C].sort())
        expect(runningContainers).not.toContain(UNLABELED)
        expect(runningContainers).not.toContain(`${LIVE}-also-1`)

        expect(metrics.get(A)?.cpuPercent).toBe(10)
        expect(metrics.get(AB)?.cpuPercent).toBe(20)
        expect(metrics.get(LIVE)?.cpuPercent).toBe(11)
        expect(metrics.get(DOTTED)?.cpuPercent).toBe(22)
        expect(metrics.size).toBe(4)
        expect(metrics.has(BAK_PROJECT)).toBe(false)

        const calls = await readCalls()
        const statsCall = calls.find(c => c.startsWith('stats '))
        expect(statsCall).toBeTruthy()
        expect(statsCall).not.toMatch(new RegExp(`\\b${UNLABELED}\\b`))
        expect(statsCall).not.toMatch(/-also-1\b/)
        for (const n of [A_C, AB_C, LIVE_C, BAK_C]) expect(statsCall).toContain(n)
    })

    it('metricsMessage shape is unchanged (type, v, engineId, sampledAt, instances keyed by instance id)', async () => {
        await writeFakeDocker(`${LIVE_C}\t${LIVE}\n${BAK_C}\t${BAK_PROJECT}\n`, {
            [LIVE_C]: statsLine(LIVE_C, '11.00%'),
            [BAK_C]:  statsLine(BAK_C, '22.00%'),
        })
        const { metrics } = await collectMetrics([LIVE, DOTTED])
        const instances: Record<string, DockerMetrics> = {}
        for (const [id, m] of metrics) instances[id] = m
        const sampledAt = 1_700_000_000_000
        const msg = metricsMessage('ENGINE_me', sampledAt, instances)

        expect(msg).toEqual({
            type: METRICS_TYPE,
            v: 1,
            engineId: 'ENGINE_me',
            sampledAt,
            instances,
        })
        expect(msg.type).toBe('idea/metrics')
        expect(Object.keys(msg.instances).sort()).toEqual([DOTTED, LIVE].sort())
        for (const m of Object.values(msg.instances)) {
            expect(Object.keys(m).sort()).toEqual([...METRIC_KEYS].sort())
            expect(typeof m.cpuPercent).toBe('number')
            expect(typeof m.memUsageBytes).toBe('number')
            expect(typeof m.sampledAt).toBe('number')
        }
        expect(msg.instances[LIVE].cpuPercent).toBe(11)
        expect(msg.instances[DOTTED].cpuPercent).toBe(22)
    })

    it('memUsageBytes is null, not 0, when docker reports 0B/0B or there is no memory data (idea#518)', async () => {
        const C1 = `${A}-app-1`
        const C2 = `${A}-app-2`
        const ps = `${C1}\t${A}\n${C2}\t${A}\n${LIVE_C}\t${LIVE}\n${AB_C}\t${AB}\n`
        await writeFakeDocker(ps, {
            [C1]: statsLine(C1, '1.00%', '0B / 0B', '0.00%'),
            [C2]: statsLine(C2, '2.00%', '0B / 0B', '0.00%'),
            [LIVE_C]: statsLine(LIVE_C, '11.00%', '', '0.00%'),
            [AB_C]: statsLine(AB_C, '3.00%', '0B /', '0.00%'),
        })
        const { metrics } = await collectMetrics([A, LIVE, AB])

        // Two containers, both 0B/0B (no memory cgroup): stay null after the merge, not 0
        expect(metrics.get(A)?.cpuPercent).toBe(3)
        expect(metrics.get(A)?.memUsageBytes).toBeNull()
        expect(metrics.get(A)?.memLimitBytes).toBeNull()
        expect(metrics.get(A)?.memPercent).toBeNull()
        expect(metrics.get(A)?.netRxBytes).toBe(2000) // two containers, 1.00kB each
        expect(metrics.get(A)?.netTxBytes).toBe(4000)

        // Empty MemUsage (no data)
        expect(metrics.get(LIVE)?.memUsageBytes).toBeNull()
        expect(metrics.get(LIVE)?.memLimitBytes).toBeNull()
        expect(metrics.get(LIVE)?.cpuPercent).toBe(11)

        // Usage 0B and no parseable limit (no data)
        expect(metrics.get(AB)?.memUsageBytes).toBeNull()
        expect(metrics.get(AB)?.memLimitBytes).toBeNull()
        expect(metrics.get(AB)?.memPercent).toBeNull()
    })

    it('real memory values stay numbers, including a real 0 usage when a limit is present (idea#518)', async () => {
        const C1 = `${A}-app-1`
        const C2 = `${A}-app-2`
        const ps = `${C1}\t${A}\n${C2}\t${A}\n${LIVE_C}\t${LIVE}\n`
        await writeFakeDocker(ps, {
            [C1]: statsLine(C1, '1.00%', '128MiB / 1GiB', '12.50%'),
            [C2]: statsLine(C2, '2.00%', '128MiB / 1GiB', '12.50%'),
            [LIVE_C]: statsLine(LIVE_C, '11.00%', '0B / 1GiB', '0.00%'),
        })
        const { metrics } = await collectMetrics([A, LIVE])
        expect(metrics.get(A)?.memUsageBytes).toBe(2 * 128 * 1024 ** 2)
        expect(metrics.get(A)?.memLimitBytes).toBe(1024 ** 3) // first container; limits are not summed
        expect(metrics.get(A)?.memPercent).toBe(12.5)
        expect(metrics.get(LIVE)?.memUsageBytes).toBe(0)
        expect(metrics.get(LIVE)?.memLimitBytes).toBe(1024 ** 3)
        expect(metrics.get(LIVE)?.memPercent).toBe(0)
    })
})
