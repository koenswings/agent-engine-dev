import { $, YAML, chalk, fs } from "zx";
import { log } from "../utils/utils.js";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ##################################################################################################
// Type Definitions
// ##################################################################################################

export interface Settings {
    mdns: boolean;
    isDev: boolean;
    testMode: boolean;
    port: number;
    httpPort: number;
    consolePath: string;
    storeDataFolder: string;
    storeIdentityFolder: string;
}

export interface Defaults {
    user: string;
    machine: string;
    password: string;
    engine: string;
    network: string;
    language: string;
    keyboard: string;
    timezone: string;
    upgrade: boolean;
    hdmi: boolean;
    temperature: boolean;
    argon: boolean;
    zerotier: boolean;
    raspap: boolean;
    gadget: boolean;
    nodocker: boolean;
    gitAccount: string;
    enginePath: string;
}

export interface InstanceConfig {
    instanceName: string;
    appName: string;
    version: string;
    title: string;
}

export interface DiskConfig {
    diskId: string;
    type: "AppDisk";
    instances: InstanceConfig[];
}

export interface EngineConfig {
    name: string;
    hostname: string;
}

export type TestAction = 
    | { type: "runCommand"; command: string; }
    | { type: "sendCommand"; targetEngineName: string; command: string; };

export interface TestAssertion {
    description: string;
    path: string;
    should: string;
}

export interface TestSequenceItem {
    stage: number;
    description: string;
    manualInstruction: string | null;
    action: TestAction | null;
    assert: TestAssertion[];
}

export interface TestSetup {
    resetBeforeTest: boolean;
    engines: EngineConfig[];
    disks: DiskConfig[];
    interactiveTestSequence: TestSequenceItem[];
    automatedTestSequence: TestSequenceItem[];
}

export interface Config {
    settings: Settings;
    defaults: Defaults;
    testSetup: TestSetup;
}

// ##################################################################################################
// Validation Logic
// ##################################################################################################

function validate<T>(obj: any, validator: (obj: any, path: string) => string[]): string[] {
    return validator(obj, '');
}

function validateSettings(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.mdns !== 'boolean') errors.push(`'${path}mdns' must be a boolean.`);
    if (typeof obj.isDev !== 'boolean') errors.push(`'${path}isDev' must be a boolean.`);
    if (typeof obj.testMode !== 'boolean') errors.push(`'${path}testMode' must be a boolean.`);
    if (typeof obj.port !== 'number') errors.push(`'${path}port' must be a number.`);
    if (typeof obj.storeDataFolder !== 'string') errors.push(`'${path}storeDataFolder' must be a string.`);
    if (typeof obj.storeIdentityFolder !== 'string') errors.push(`'${path}storeIdentityFolder' must be a string.`);
    return errors;
}

function validateDefaults(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.user !== 'string') errors.push(`'${path}user' must be a string.`);
    if (typeof obj.enginePath !== 'string') errors.push(`'${path}enginePath' must be a string.`);
    // Add other default checks here as needed for completeness
    return errors;
}

function validateTestAction(obj: any, path: string): string[] {
    if (obj === null) return [];
    const errors: string[] = [];
    if (typeof obj !== 'object') return [`'${path}' must be an object or null.`];
    
    switch (obj.type) {
        case 'runCommand':
            if (typeof obj.command !== 'string') errors.push(`'${path}command' must be a string for runCommand.`);
            break;
        case 'sendCommand':
            if (typeof obj.targetEngineName !== 'string') errors.push(`'${path}targetEngineName' must be a string for sendCommand.`);
            if (typeof obj.command !== 'string') errors.push(`'${path}command' must be a string for sendCommand.`);
            break;
        default:
            errors.push(`'${path}type' has an unknown value: ${obj.type}.`);
    }
    return errors;
}

function validateTestSequenceItem(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.stage !== 'number') errors.push(`'${path}stage' must be a number.`);
    if (typeof obj.description !== 'string') errors.push(`'${path}description' must be a string.`);
    if (typeof obj.manualInstruction !== 'string' && obj.manualInstruction !== null) errors.push(`'${path}manualInstruction' must be a string or null.`);
    errors.push(...validateTestAction(obj.action, `${path}action.`));
    if (!Array.isArray(obj.assert)) errors.push(`'${path}assert' must be an array.`);
    return errors;
}

function validateTestSetup(obj: any, path: string): string[] {
    const errors: string[] = [];
    if (typeof obj.resetBeforeTest !== 'boolean') errors.push(`'${path}resetBeforeTest' must be a boolean.`);
    if (!Array.isArray(obj.engines)) errors.push(`'${path}engines' must be an array.`);
    if (!Array.isArray(obj.disks)) errors.push(`'${path}disks' must be an array.`);
    if (!Array.isArray(obj.interactiveTestSequence)) errors.push(`'${path}interactiveTestSequence' must be an array.`);
    else errors.push(...obj.interactiveTestSequence.flatMap((item, i) => validateTestSequenceItem(item, `${path}interactiveTestSequence[${i}].`)));
    if (!Array.isArray(obj.automatedTestSequence)) errors.push(`'${path}automatedTestSequence' must be an array.`);
    else errors.push(...obj.automatedTestSequence.flatMap((item, i) => validateTestSequenceItem(item, `${path}automatedTestSequence[${i}].`)));
    return errors;
}

function validateConfig(obj: any): string[] {
    const errors: string[] = [];
    if (!obj) return ["Config object is null or undefined."];
    errors.push(...validateSettings(obj.settings, 'settings.'));
    errors.push(...validateDefaults(obj.defaults, 'defaults.'));
    errors.push(...validateTestSetup(obj.testSetup, 'testSetup.'));
    return errors.filter(e => e); // Filter out empty strings/nulls
}

// ##################################################################################################
// Configuration Loading
// ##################################################################################################

const readConfig = (path: string): Config => {
  try {
    const configFile = fs.readFileSync(path, 'utf8');
    const parsedConfig = YAML.parse(configFile);

    const validationErrors = validateConfig(parsedConfig);
    if (validationErrors.length > 0) {
        console.error(chalk.red('Config file validation failed!'));
        validationErrors.forEach(error => console.error(chalk.red(`  - ${error}`)));
        process.exit(1);
    }

    log(chalk.green('Config file is valid.'));
    return parsedConfig as Config;

  } catch (e) {
    log(chalk.red('Error reading or parsing config.yaml!'));
    console.error(e);
    process.exit(1);
  }
}

export const config = readConfig('./config.yaml');

// Allow IDEA_TEST_MODE=true env var to force testMode on without editing config.yaml.
// NOTE: This mutates the already-exported config object at module load time.
// Safe only because all consumers read config.settings.testMode inside function bodies,
// not at module scope. If any future module reads testMode at import time, this will
// silently not apply to that module — move to a getter pattern at that point.
// This must be set before any module that reads config at import time (e.g. Engine.ts).
if (process.env.IDEA_TEST_MODE === 'true') {
    config.settings.testMode = true;
}