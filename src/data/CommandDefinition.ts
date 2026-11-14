import { DocHandle } from "@automerge/automerge-repo";
import { Store } from "./Store.js";

// Generalized argument types
type ArgumentType = 'string' | 'number' | 'object';

// Updated FieldSpec to support multiple types
interface FieldSpec {
    type: 'number' | 'string'; // Extend this as needed
}

interface ObjectSpec {
    [key: string]: FieldSpec;
}

// Updated ArgumentDescriptor to include ObjectSpec
export interface ArgumentDescriptor {
    type: ArgumentType;
    name?: string;        // Human-readable arg name, used to build named trace args
    objectSpec?: ObjectSpec;
    variadic?: boolean;   // Last arg only: takes all remaining tokens (at least one), passed as separate args
    optional?: boolean;   // Last arg only: the token(s) may be absent (zero tokens). With variadic, remaining tokens are collected and the trace records an array (possibly []) (idea#128). Without variadic, at most one token; the trace records the string or null, and extra tokens are still "Too many arguments".
}

// Interface for commands
export interface CommandDefinition {
    name: string;
    execute: (storeHandle: DocHandle<Store> | null, ...args: any[]) => void | Promise<void>;
    args: ArgumentDescriptor[];
    scope: 'engine' | 'console' | 'any';
}