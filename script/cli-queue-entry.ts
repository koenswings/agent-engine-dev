/**
 * cli-queue-entry.ts — a queue entry signed by this Pi's Engine, for scripts that run
 * ON the Engine's Pi as its user (engine#582). The Engine runs only signed entries;
 * the key is read from the Engine's auth folder (IDEA_AUTH_DIR, config authFolder,
 * or ~/.idea-engine/auth). Source in the trace: cli.
 */
import { signEntry } from '../src/data/CommandKey.js'

export const cliQueueEntry = (command: string, engineId: string): string => signEntry(command, 'cli', engineId).entry
