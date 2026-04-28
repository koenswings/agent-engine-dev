import { DocHandle } from "@automerge/automerge-repo";
import { Store } from "../data/Store.js";
import { Command, EngineID } from "../data/CommonTypes.js";
import { ArgumentDescriptor, CommandDefinition } from "../data/CommandDefinition.js";
import { CommandLogStore, addTrace, closeTrace } from "../data/CommandLogStore.js";
import { runWithTrace, flushTrace } from "./CommandLogger.js";


export const handleCommand = async (
    commands: CommandDefinition[],
    storeHandle: DocHandle<Store> | null,
    context: 'console' | 'engine',
    input: string,
    commandLogHandle?: DocHandle<CommandLogStore> | null
): Promise<void> => {
    const trimmedInput = input.trim();
    const commandName = trimmedInput.split(' ')[0];
    const command = commands.find(cmd => cmd.name === commandName);

    if (!command) {
        console.log(`Unknown command: ${commandName}`);
        return;
    }

    let stringArgs: string[] = [];
    // Special case for commands that take the entire rest of the line as a single argument
    if (command.args.length === 1) {
        const firstSpaceIndex = trimmedInput.indexOf(' ');
        if (firstSpaceIndex !== -1) {
            stringArgs.push(trimmedInput.substring(firstSpaceIndex + 1));
        }
    } else {
        stringArgs = trimmedInput.split(' ').slice(1).filter(arg => arg.length > 0);
    }

    // Scope checking
    if (context === 'console' && command.scope === 'engine') {
        console.log(`Error: Command '${commandName}' can only be executed on an engine. Use 'send <engineId> ${commandName} ...' to execute it remotely.`);
        return;
    }

    if (context === 'engine' && command.scope === 'console') {
        console.log(`Error: Command '${commandName}' can only be executed on a console.`);
        return;
    }

    let args: any[];
    try {
        args = stringArgs.map((arg, index) => {
            if (index >= command.args.length) throw new Error("Too many arguments");
            return convertToType(arg, command.args[index]);
        });
        if (args.length < command.args.length) throw new Error("Insufficient arguments");
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        return;
    }

    // ── Trace setup ──────────────────────────────────────────────────────────
    const traceId = crypto.randomUUID();
    const traceCtx = { traceId, command: commandName, args: JSON.stringify(stringArgs) };

    if (commandLogHandle) {
        addTrace(commandLogHandle, {
            traceId,
            command: commandName,
            args: JSON.stringify(stringArgs),
            startedAt: Date.now(),
            completedAt: null,
            status: 'running',
            errorMessage: null,
        });
    }

    // ── Execute inside trace context ─────────────────────────────────────────
    try {
        await runWithTrace(traceCtx, async () => { await command.execute(storeHandle, ...args); });
        if (commandLogHandle) {
            await flushTrace(traceId);
            closeTrace(commandLogHandle, traceId, 'ok');
        }
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
        if (commandLogHandle) {
            await flushTrace(traceId);
            closeTrace(commandLogHandle, traceId, 'error', error.message);
        }
    }
}


/**
 * A dependency-free utility to add a command to a specific engine's command array in the store.
 * This is used by tests and the 'send' command definition.
 */
export const sendCommand = (storeHandle: DocHandle<Store>, engineId: EngineID, command: Command): void => {
    console.log(`Sending command '${command}' to engine ${engineId}`);

    const store = storeHandle.doc();
    if (!store?.engineDB[engineId]) {
        console.error(`Cannot send command: Engine ${engineId} not found in store.`);
        return;
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
