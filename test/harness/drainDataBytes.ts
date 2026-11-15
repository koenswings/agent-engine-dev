/**
 * drainDataBytes — test teardown for the engine#430 background size queue.
 *
 * A successful backup and the end of processDisk queue `idea-app-data size` on
 * the shared dataBytesQueue. That work uses the test's fake sudo (which appends
 * to a temp-dir log) or `du`s the instance folder. If teardown removes those
 * paths first, rmdir fails with ENOTEMPTY even though every assertion passed.
 *
 * Call this before removing temp dirs or the fake sudo. It waits for the
 * in-flight measurement, then drops any retry. Production behaviour is unchanged.
 */
import { dataBytesQueue } from '../../src/data/DataBytes.js'

export const drainDataBytesQueue = (): Promise<void> => dataBytesQueue.reset()
