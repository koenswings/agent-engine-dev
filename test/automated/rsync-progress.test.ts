/**
 * rsync-progress.test.ts — parse rsync --info=progress2 byte counts (engine#387).
 */
import { describe, it, expect } from 'vitest'
import { parseRsyncProgress2 } from '../../src/utils/rsync.js'

describe('parseRsyncProgress2', () => {
    it('reads bytes and percent from a progress2 line, including CR updates', () => {
        expect(parseRsyncProgress2('  1,234,567  42%    1.23MB/s    0:00:05')).toEqual({
            progressPercent: 42, bytesDone: 1_234_567,
        })
        expect(parseRsyncProgress2('hello\r      8,409,088 100%    4.00MB/s    0:00:02 (xfr#1, to-chk=0/3)')).toEqual({
            progressPercent: 100, bytesDone: 8_409_088,
        })
        expect(parseRsyncProgress2('no progress here')).toBeNull()
    })
})
