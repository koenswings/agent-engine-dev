/**
 * Opt-in walk recording (--record-walk <DIR>).
 * Captures step-NNNN-<action>.png after UI / live-page steps; assembles walk.mp4 via ffmpeg.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const FFMPEG_BIN = '/usr/bin/ffmpeg'

export const sanitizeActionForFilename = (action: string): string =>
    action.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'action'

/** step-NNNN-<action>.png (1-based zero-padded index). */
export const framePath = (dir: string, step: number, action: string): string => {
    const n = String(Math.max(1, step)).padStart(4, '0')
    return join(dir, `step-${n}-${sanitizeActionForFilename(action)}.png`)
}

export const ensureRecordWalkDir = (dir: string): void => {
    mkdirSync(dir, { recursive: true })
}

export const listFramePngs = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
        .filter(f => /^step-\d+-.+\.png$/i.test(f))
        .sort()
}

export type RecordWalkLog = (entry: Record<string, unknown>) => void

const defaultLog: RecordWalkLog = (entry) => {
    console.log(JSON.stringify(entry))
}

export const logRecordWalkFrame = (
    opts: { dir: string; step: number; action: string; path: string },
    log: RecordWalkLog = defaultLog,
): void => {
    log({
        event: 'record_walk_frame',
        step: opts.step,
        action: opts.action,
        path: opts.path,
        dir: opts.dir,
    })
}

export const logRecordWalkSkip = (
    opts: { dir: string; step: number; action: string; reason: string },
    log: RecordWalkLog = defaultLog,
): void => {
    log({
        event: 'record_walk_skip',
        step: opts.step,
        action: opts.action,
        reason: opts.reason,
        dir: opts.dir,
    })
}

export const logRecordWalkVideo = (
    opts: { dir: string; path?: string; ok: boolean; frames: number; reason?: string },
    log: RecordWalkLog = defaultLog,
): void => {
    log({
        event: 'record_walk_video',
        dir: opts.dir,
        path: opts.path ?? null,
        ok: opts.ok,
        frames: opts.frames,
        reason: opts.reason ?? null,
    })
}

/**
 * After a UI Intent: log frame if PNG exists, else skip.
 * Caller is responsible for asking the driver to capture first.
 */
export const finalizeRecordedFrame = (
    opts: {
        dir: string
        step: number
        action: string
        path: string
        /** stub / no playwright page */
        skipped?: boolean
        skipReason?: string
    },
    log: RecordWalkLog = defaultLog,
): void => {
    if (opts.skipped) {
        logRecordWalkSkip({
            dir: opts.dir,
            step: opts.step,
            action: opts.action,
            reason: opts.skipReason ?? 'stub_ui_no_page',
        }, log)
        return
    }
    if (existsSync(opts.path)) {
        logRecordWalkFrame({
            dir: opts.dir,
            step: opts.step,
            action: opts.action,
            path: opts.path,
        }, log)
    } else {
        logRecordWalkSkip({
            dir: opts.dir,
            step: opts.step,
            action: opts.action,
            reason: 'no_png_written',
        }, log)
    }
}

/**
 * Assemble walk.mp4 from step-*.png via ffmpeg. No-op (logged) when no frames.
 */
export const assembleWalkVideo = (
    dir: string,
    log: RecordWalkLog = defaultLog,
): { ok: boolean; path?: string; frames: number; reason?: string } => {
    const frames = listFramePngs(dir)
    if (frames.length === 0) {
        const reason = 'no_png_frames'
        logRecordWalkVideo({ dir, ok: false, frames: 0, reason }, log)
        return { ok: false, frames: 0, reason }
    }
    if (!existsSync(FFMPEG_BIN)) {
        const reason = `ffmpeg_missing:${FFMPEG_BIN}`
        logRecordWalkVideo({ dir, ok: false, frames: frames.length, reason }, log)
        return { ok: false, frames: frames.length, reason }
    }
    const outName = 'walk.mp4'
    const outPath = join(dir, outName)
    const r = spawnSync(
        FFMPEG_BIN,
        [
            '-y',
            '-framerate', '2',
            '-pattern_type', 'glob',
            '-i', 'step-*.png',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            outName,
        ],
        { cwd: dir, encoding: 'utf8' },
    )
    if (r.status !== 0 || !existsSync(outPath)) {
        const reason = `ffmpeg_failed:status=${r.status}:${(r.stderr ?? r.stdout ?? '').slice(0, 200)}`
        logRecordWalkVideo({ dir, ok: false, frames: frames.length, reason }, log)
        return { ok: false, frames: frames.length, reason }
    }
    logRecordWalkVideo({ dir, path: outPath, ok: true, frames: frames.length }, log)
    return { ok: true, path: outPath, frames: frames.length }
}
