import { DocHandle } from "@automerge/automerge-repo";
import { Store } from "../data/Store.js";
import { Command, EngineID } from "../data/CommonTypes.js";
import { ArgumentDescriptor, CommandDefinition } from "../data/CommandDefinition.js";
import { CommandLogStore, addTrace, closeTrace, getCommandLogHandle, takePendingTraceResult, takePendingTraceCloseMessage } from "../data/CommandLogStore.js";
import { runWithTrace, flushTrace } from "./CommandLogger.js";
import { print } from './utils.js';
import { redactString } from './redact.js';
import { setupDemoTraceApps } from '../data/DemoApps.js';
import { lookupInstanceArg } from '../data/InstanceArg.js';
import { CommandSource, cleanCommandSource, isRemoteSource } from '../data/CommandSource.js';
import { appendAudit } from '../data/CommandAudit.js';
import { localEngineId } from '../data/Engine.js';


/**
 * One-shot error trace for refusals before execute (unknown command, scope,
 * argument parse). idea#122: every queued command must leave a trace the
 * Console can show; previously these paths printed and returned with no trace.
 */
const recordErrorTrace = (
    commandLogHandle: DocHandle<CommandLogStore> | null | undefined,
    commandName: string,
    argsJson: string,
    message: string,
    opts: HandleCommandOptions = {},
    errorCode: string | null = null,
): void => {
    const source = cleanCommandSource(opts.source)
    appendAudit({
        t: Date.now(), engineId: String(localEngineId), seq: opts.seq ?? null,
        command: commandName || '(empty)', args: argsJson, source: source ?? null,
        result: 'refused', errorCode,
    })
    if (!commandLogHandle) return;
    const traceId = crypto.randomUUID();
    addTrace(commandLogHandle, {
        traceId,
        command: commandName || '(empty)',
        args: redactString(argsJson),
        startedAt: Date.now(),
        completedAt: null,
        status: 'running',
        errorMessage: null,
        ...(source ? { source } : {}),
        ...(typeof opts.seq === 'number' ? { seq: opts.seq } : {}),
    });
    closeTrace(commandLogHandle, traceId, 'error', redactString(message), undefined, errorCode);
}

/**
 * engine#582: options for handleCommand. `source` says who asked (recorded on the
 * trace and in the audit log); `seq` is the signed queue entry's sequence number.
 * Callers that pass no source are in-process (tests, the Engine itself).
 */
export interface HandleCommandOptions {
    source?: CommandSource
    seq?: number
}

/**
 * engine#582: commands that never run when they come from outside this Pi
 * (an operator, a peer, or an unknown queue writer). createInstance clones an app
 * from a GitHub account given as an argument; installApp replaces it.
 */
export const LOCAL_ONLY_COMMANDS: readonly string[] = ['createInstance']

/** Stable refusal code for a local-only command sent from outside (engine#582). */
export const COMMAND_REFUSED = 'COMMAND_REFUSED'


/**
 * Split the argument part of a command line into tokens (idea#168 r29@97).
 *
 * Without a double quote this is exactly the old split on single spaces
 * (empty tokens dropped). With quotes, a token that starts with `"` runs to
 * the next `"` that ends a token (followed by a space or the end), so a disk
 * name with spaces can be one argument: `restoreApp kolibri "My Disk"`. The
 * quotes are removed. A `"` inside a token, or an opening quote with no
 * closing one, stays literal.
 */
export const splitArgs = (argString: string): string[] => {
    if (!argString.includes('"')) return argString.split(' ').filter(arg => arg.length > 0);
    const tokens: string[] = [];
    let i = 0;
    while (i < argString.length) {
        if (argString[i] === ' ') { i++; continue; }
        if (argString[i] === '"') {
            let close = argString.indexOf('"', i + 1);
            while (close !== -1 && close + 1 < argString.length && argString[close + 1] !== ' ') {
                close = argString.indexOf('"', close + 1);
            }
            if (close !== -1) {
                tokens.push(argString.substring(i + 1, close));
                i = close + 1;
                continue;
            }
        }
        let end = argString.indexOf(' ', i);
        if (end === -1) end = argString.length;
        tokens.push(argString.substring(i, end));
        i = end;
    }
    return tokens;
}


export const handleCommand = async (
    commands: CommandDefinition[],
    storeHandle: DocHandle<Store> | null,
    context: 'console' | 'engine',
    input: string,
    commandLogHandle?: DocHandle<CommandLogStore> | null,
    opts: HandleCommandOptions = {},
): Promise<void> => {
    const source = cleanCommandSource(opts.source)
    const trimmedInput = input.trim();
    const commandName = trimmedInput.split(' ')[0];
    const command = commands.find(cmd => cmd.name === commandName);

    if (!command) {
        const message = `Unknown command: ${commandName}`;
        print(message);
        recordErrorTrace(
            commandLogHandle,
            commandName || '(empty)',
            JSON.stringify({ input: trimmedInput }),
            message,
            opts
        );
        return;
    }

    // A variadic last arg takes all remaining tokens (see ArgumentDescriptor.variadic)
    const lastArg = command.args[command.args.length - 1];
    const isVariadic = lastArg?.variadic === true;

    let stringArgs: string[] = [];
    // Special case for commands that take the entire rest of the line as a single argument
    if (command.args.length === 1 && !isVariadic) {
        const firstSpaceIndex = trimmedInput.indexOf(' ');
        if (firstSpaceIndex !== -1) {
            stringArgs.push(trimmedInput.substring(firstSpaceIndex + 1));
        }
    } else {
        stringArgs = splitArgs(trimmedInput.split(' ').slice(1).join(' '));
    }

    // Scope checking
    if (context === 'console' && command.scope === 'engine') {
        const message = `Error: Command '${commandName}' can only be executed on an engine. Use 'send <engineId> ${commandName} ...' to execute it remotely.`;
        print(message);
        recordErrorTrace(commandLogHandle, commandName, JSON.stringify(stringArgs), message, opts);
        return;
    }

    if (context === 'engine' && command.scope === 'console') {
        const message = `Error: Command '${commandName}' can only be executed on a console.`;
        print(message);
        recordErrorTrace(commandLogHandle, commandName, JSON.stringify(stringArgs), message, opts);
        return;
    }

    if (LOCAL_ONLY_COMMANDS.includes(commandName) && isRemoteSource(source)) {
        const message = `Error: '${commandName}' only runs from the command line on this Engine. Use installApp instead.`;
        print(message);
        recordErrorTrace(commandLogHandle, commandName, JSON.stringify(stringArgs), message, opts, COMMAND_REFUSED);
        return;
    }

    let args: any[];
    try {
        args = stringArgs.map((arg, index) => {
            const descriptor = isVariadic && index >= command.args.length - 1 ? lastArg : command.args[index];
            if (!descriptor) throw new Error("Too many arguments");
            return convertToType(arg, descriptor);
        });
        // An optional last arg may take zero tokens (idea#128 for variadic; a single optional token too)
        const required = lastArg?.optional ? command.args.length - 1 : command.args.length;
        if (args.length < required) throw new Error("Insufficient arguments");
    } catch (error: any) {
        const message = `Error: ${error.message}`;
        console.error(message);
        recordErrorTrace(commandLogHandle, commandName, JSON.stringify(stringArgs), message, opts);
        return;
    }

    // ── Trace setup ──────────────────────────────────────────────────────────
    const traceId = crypto.randomUUID();
    // Build a named args object when the CommandDefinition has arg names defined,
    // otherwise fall back to a positional array. The Console filters traces by
    // args['instanceId'] (or, before engine#399, args['instanceName']), so named
    // args are required.
    // A variadic last arg is recorded as an array of all its tokens.
    const namedArgs: Record<string, string | string[] | null> | string[] =
        command.args.every(a => a.name)
            ? Object.fromEntries(command.args.map((a, i) =>
                [a.name!, a.variadic ? stringArgs.slice(i) : stringArgs[i] ?? null]))
            : stringArgs
    // setupDemo: COMMANDS.md documents args.apps as a comma-separated string, not the raw `--apps` tokens.
    if (commandName === 'setupDemo' && !Array.isArray(namedArgs)) {
        const rest = Array.isArray(namedArgs.apps) ? namedArgs.apps as string[] : []
        namedArgs.apps = setupDemoTraceApps(rest)
    }
    if (!Array.isArray(namedArgs)) addTraceInstanceIdentity(storeHandle, namedArgs)
    const argsJson = JSON.stringify(namedArgs);
    const traceCtx = { traceId, command: commandName, args: argsJson };

    if (commandLogHandle) {
        addTrace(commandLogHandle, {
            traceId,
            command: commandName,
            args: argsJson,
            startedAt: Date.now(),
            completedAt: null,
            status: 'running',
            errorMessage: null,
            ...(source ? { source } : {}),
            ...(typeof opts.seq === 'number' ? { seq: opts.seq } : {}),
        });
    }
    const audit = (result: 'ok' | 'error', errorCode: string | null = null) => appendAudit({
        t: Date.now(), engineId: String(localEngineId), seq: opts.seq ?? null,
        command: commandName, args: argsJson, source: source ?? null, result, errorCode,
    })

    // ── Execute inside trace context ─────────────────────────────────────────
    try {
        await runWithTrace(traceCtx, async () => { await command.execute(storeHandle, ...args); });
        if (commandLogHandle) {
            await flushTrace(traceId);
            closeTrace(commandLogHandle, traceId, 'ok', takePendingTraceCloseMessage(traceId));
        }
        audit('ok')
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        if (commandLogHandle) {
            await flushTrace(traceId);
            takePendingTraceResult(traceId); // discard — do not publish result on error
            takePendingTraceCloseMessage(traceId);
            // An error may carry a stable machine code and its own result (idea#79 moveApp)
            const errorCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : null
            const errorResult = error?.traceResult !== undefined ? JSON.stringify(error.traceResult) : null
            closeTrace(commandLogHandle, traceId, 'error', error.message, errorResult, errorCode);
        }
        audit('error', typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : null)
    }
}


/**
 * engine#399: a named `instanceId` trace arg is the instance id, and `instanceName`
 * its display name. The registry arg holds what the sender typed (an id, or a name
 * that resolves id-first, idea#168); when it resolves (InstanceArg.ts, with the
 * command's disk arg for a shared name), `instanceId` becomes the resolved id and
 * `instanceName` the instance's name at the time the command starts. When it does
 * not resolve (not found, ambiguous, no store), `instanceId` keeps the raw argument
 * and `instanceName` is null, so a refusal still carries what was sent.
 */
export const addTraceInstanceIdentity = (
    storeHandle: DocHandle<Store> | null,
    namedArgs: Record<string, string | string[] | null>
): void => {
    const raw = namedArgs.instanceId
    if (typeof raw !== 'string' || raw === '') return
    let name: string | null = null
    try {
        const store = storeHandle?.doc()
        if (store) {
            const diskArg = [namedArgs.diskId, namedArgs.sourceDiskId].find((d): d is string => typeof d === 'string' && d !== '')
            const found = lookupInstanceArg(store, raw, diskArg)
            if (found.ok) {
                namedArgs.instanceId = String(found.instance.id)
                name = found.instance.name != null ? String(found.instance.name) : null
            }
        }
    } catch {
        // A trace never fails a command: keep the raw argument.
    }
    namedArgs.instanceName = name
}

/**
 * A dependency-free utility to add a command to a specific engine's command array in the store.
 * This is used by tests and the 'send' command definition.
 */
export const sendCommand = (storeHandle: DocHandle<Store>, engineId: EngineID, command: Command): void => {
    print(`Sending command '${command}' to engine ${engineId}`);

    const store = storeHandle.doc();
    if (!store?.engineDB[engineId]) {
        console.error(`Cannot send command: Engine ${engineId} not found in store.`);
        return;
    }

    // Trace the dispatch on the originating engine so the Console shows
    // cross-engine commands in history (e.g. copyApp dispatching startInstance
    // to a remote engine). This is a one-shot trace with no log lines.
    const cmdLogHandle = getCommandLogHandle()
    if (cmdLogHandle) {
        const commandName = String(command).split(' ')[0]
        const traceId = crypto.randomUUID()
        addTrace(cmdLogHandle, {
            traceId,
            command: commandName,
            args: JSON.stringify({ dispatchedTo: engineId, command: String(command) }),
            startedAt: Date.now(),
            completedAt: Date.now(),
            status: 'running',
            errorMessage: null,
        })
        closeTrace(cmdLogHandle, traceId, 'ok')
    }

    storeHandle.change(doc => {
        const engine = doc.engineDB[engineId];
        if (engine) {
            engine.commands.push(command);
        }
    });
}
const convertToType = (str: string, descriptor: ArgumentDescriptor): any => {
    switch (descriptor.type) {
        case "number":
            const num = parseFloat(str);
            if (isNaN(num)) throw new Error("Cannot convert to number");
            return num;
        case "string":
            return str;
        case "object":
            if (!descriptor.objectSpec) throw new Error("Object specification is missing");
            try {
                const obj = JSON.parse(str);
                for (const [key, fieldSpec] of Object.entries(descriptor.objectSpec)) {
                    if (!(key in obj)) throw new Error(`Missing key '${key}' in object`);
                    switch (fieldSpec.type) {
                        case 'number':
                            const value = parseFloat(obj[key]);
                            if (isNaN(value)) throw new Error(`Key '${key}' is not a valid number`);
                            obj[key] = value;
                            break;
                        case 'string':
                            if (typeof obj[key] !== 'string') throw new Error(`Key '${key}' is not a valid string`);
                            break;
                    }
                }
                return obj;
            } catch {
                throw new Error("Cannot convert to object");
            }
        default:
            throw new Error("Unsupported type");
    }
}
