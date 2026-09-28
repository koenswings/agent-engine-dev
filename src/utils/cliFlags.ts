/**
 * Boolean command-line flags for build-engine (idea#146).
 *
 * zx's `argv` is minimist without declared booleans, so a flag can arrive as:
 *   --argon            true
 *   --no-argon         false
 *   --argon=false      'false' (a string)
 *   --argon false      'false' (a string)
 *   (absent)           undefined
 *
 * The old `argv.argon || defaults.argon` could never turn off an option whose
 * config default is true (argon, gadget). parseBoolFlag uses the flag whenever it
 * is present and falls back to the default only when it is absent.
 */
const TRUE_WORDS = ['true', 'yes', 'on', '1']
const FALSE_WORDS = ['false', 'no', 'off', '0']

export const parseBoolFlag = (value: unknown, fallback: boolean): boolean => {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase()
        if (v === '') return true            // `--argon=` counts as present
        if (TRUE_WORDS.includes(v)) return true
        if (FALSE_WORDS.includes(v)) return false
    }
    // Arrays (flag given twice) and anything else: the last value wins.
    if (Array.isArray(value) && value.length > 0) return parseBoolFlag(value[value.length - 1], fallback)
    throw new Error(`Not a boolean flag value: ${JSON.stringify(value)} (use --flag, --no-flag or --flag=true|false)`)
}

/** Raspberry Pi models build-engine knows about. */
export type PiModel = 'pi4' | 'pi5'

export const parseModel = (value: unknown): PiModel | undefined => {
    if (value === undefined || value === null || value === '') return undefined
    const v = String(value).trim().toLowerCase()
    if (v === 'pi4' || v === 'pi5') return v
    throw new Error(`Unknown --model ${JSON.stringify(value)}; expected pi4 or pi5`)
}

/**
 * Resolve the gadget setting for a model. USB gadget mode needs the Pi 4's DWC2
 * USB controller; the Pi 5 has a PCIe USB controller, so gadget mode must stay off.
 * Asking for it explicitly on a Pi 5 is an error; a config default of true is
 * silently overridden.
 */
export const resolveGadget = (flag: unknown, fallback: boolean, model: PiModel | undefined): boolean => {
    const gadget = parseBoolFlag(flag, fallback)
    if (model === 'pi5' && gadget) {
        if (flag !== undefined && parseBoolFlag(flag, false)) {
            throw new Error('--gadget is not supported on a Pi 5 (PCIe USB controller); leave it out or pass --no-gadget')
        }
        return false
    }
    return gadget
}
