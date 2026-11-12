/**
 * idea-usage logger (idea#411). Writes to stderr via process.stderr.write so
 * src/usage/ never uses console logging (QC) and never imports src/utils (which
 * pulls src/data types).
 */
export function usageLog(msg: string): void {
    process.stderr.write(`[idea-usage] ${msg}\n`)
}
