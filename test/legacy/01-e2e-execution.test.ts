import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { $, YAML, fs, question, os, path, chalk } from 'zx';

$.verbose = false;
import { DocHandle, Repo } from '@automerge/automerge-repo';
import { Store, getInstances, getRunningEngines } from '../src/data/Store.js';
import { Command, EngineID } from '../src/data/CommonTypes.js';
import { commands } from '../src/data/Commands.js';
import { Config, TestAction, TestSequenceItem } from '../src/data/Config.js';
import { pEvent } from 'p-event';
import _ from 'lodash';
import { testContext } from './testContext.js';
import { handleCommand } from '../src/utils/commandUtils.js';
import { isEngineOnline } from '../src/utils/utils.js';

const CONFIG_PATH = 'config.yaml';

// Parse config synchronously before tests are defined
const configFile = fs.readFileSync(CONFIG_PATH, 'utf8');
const config: Config = YAML.parse(configFile);

// Determine which test sequence to run based on environment variables
const testMode = process.env.TEST_MODE || 'full';
const startAtStage = parseInt(process.env.START_AT_STAGE || '1', 10);
let testSequence: TestSequenceItem[] = [];

if (testMode === 'automated') {
    console.log(chalk.green('Running in AUTOMATED test mode...'));
    testSequence = config.testSetup.automatedTestSequence;
} else {
    console.log(chalk.green('Running in FULL test mode (interactive and automated)...'));
    testSequence = [...config.testSetup.interactiveTestSequence, ...config.testSetup.automatedTestSequence];
}

describe('E2E Test Runner', () => {

    // Helper to get a value from the store or test runner state
    const getValueFromPath = async (path: string) => {
        if (path.startsWith('system.')) {
            const systemProperty = path.split('.')[1];
            if (systemProperty === 'isConnected') {
                return testContext.repo && testContext.repo.peers.length > 0;
            }
            if (path.startsWith('system.isEngineOnline')) {
                const match = path.match(/system.isEngineOnline\('([\w.-]+)'\)/);
                if (!match) throw new Error(`Invalid isEngineOnline path: ${path}`);
                const hostname = match[1];
                return await isEngineOnline(hostname, config.settings.port);
            }
            if (path.startsWith('system.checkReboot')) {
                const store = testContext.storeHandle?.doc();
                if (!store) return false;
                const engineName = Object.keys(preRebootState).pop();
                if (!engineName) return false;
                const engine = getRunningEngines(store).find(e => e.hostname === engineName);
                const oldState = preRebootState[engineName];
                if (engine && engine.lastBooted > oldState.lastBooted && engine.lastRun > oldState.lastRun) {
                    const duration = (Date.now() - rebootTimers[engineName]) / 1000;
                    console.log(chalk.green(`  - Success! Engine rebooted in ${duration.toFixed(2)} seconds.`));
                    delete preRebootState[engineName];
                    delete rebootTimers[engineName];
                    return true;
                }
                return false;
            }
            return undefined;
        }

        const store = testContext.storeHandle?.doc();
        if (!store) return undefined;

        if (path.startsWith('find(')) {
            const match = path.match(/find\((\w+), { (\w+): '([\w-]+)' }\)\.?(.+)?/);
            if (!match) throw new Error(`Invalid find path: ${path}`);
            const [, collectionName, key, value, restOfPath] = match;

            let collection = _.get(store, collectionName);
            if (typeof collection === 'object' && collection !== null && !Array.isArray(collection)) {
                collection = Object.values(collection);
            }

            if (!Array.isArray(collection)) throw new Error(`Path part '${collectionName}' is not an array or object in the store.`);

            const item = collection.find((i: any) => i[key] === value);
            if (!item) return undefined;

            return restOfPath ? _.get(item, restOfPath) : item;
        } else {
            return _.get(store, path);
        }
    };

    // Helper to execute assertions
    const executeAssertion = (actualValue: any, should: string) => {
        const lengthMatch = should.match(/have.lengthOf\((\d+)\)/);
        if (lengthMatch) {
            const expectedLength = parseInt(lengthMatch[1], 10);
            if (Array.isArray(actualValue)) {
                expect(actualValue).to.have.lengthOf(expectedLength);
            } else if (typeof actualValue === 'object' && actualValue !== null) {
                expect(Object.keys(actualValue)).to.have.lengthOf(expectedLength);
            } else {
                throw new Error(`Assertion failed: expected an array or object for length check, but got ${typeof actualValue}`);
            }
            return;
        }

        const equalMatch = should.match(/equal\((.+)\)/);
        if (equalMatch) {
            const expectedValue = JSON.parse(equalMatch[1].replace(/'/g, '"'));
            expect(actualValue).to.deep.equal(expectedValue);
            return;
        }

        if (should === 'not.equal(undefined)') {
            expect(actualValue).to.not.equal(undefined);
            return;
        }

        throw new Error(`Unsupported assertion: ${should}`);
    };

    // This function orchestrates the action defined in the YAML
    const executeAction = async (action: TestAction) => {
        console.log(chalk.blue(`Executing action: ${action.type}`));
        let commandToRun = '';

        switch (action.type) {
            case 'runCommand':
                commandToRun = action.command;
                break;
            case 'sendCommand':
                commandToRun = `send ${action.targetEngineName} ${action.command}`;
                break;
        }

        console.log(`  - Running: "${commandToRun}"`);
        await handleCommand(commands, testContext.storeHandle || null, 'engine', commandToRun);

        if (action.type === 'runCommand' && action.command.startsWith('connect')) {
            console.log("  - Waiting for connection and initial sync...");
            if (testContext.storeHandle) {
                await pEvent(testContext.storeHandle, 'change', { timeout: 20000 });
            }
        }
    };

    let preRebootState: { [engineName: string]: { lastBooted: number, lastRun: number } } = {};
    let rebootTimers: { [engineName: string]: number } = {};

    before(async function () {
        this.timeout(0); // Disable timeout for manual preparation

        console.log(chalk.blue('INFO: To skip already passed stages and resume a test run, use "START_AT_STAGE=N npm run test:full"'));

        // Clear known_hosts to prevent SSH errors during re-provisioning
        console.log(chalk.yellow('Clearing SSH known_hosts file...'));
        const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
        try {
            if (fs.existsSync(knownHostsPath)) {
                await $`rm -f ${knownHostsPath}`;
                console.log(chalk.green('  - known_hosts file removed.'));
            } else {
                console.log(chalk.yellow('  - known_hosts file not found, skipping removal.'));
            }
        } catch (e: any) {
            console.error(chalk.red(`  - Could not remove known_hosts file: ${e.message}`));
        }

        if (config.testSetup.resetBeforeTest && startAtStage === 1) {
            console.log(chalk.yellow('\n============================== WARNING =============================='));
            console.log(chalk.yellow('You are running the full interactive test suite from the beginning.'));
            console.log(chalk.white('\nTo ensure a clean state, please run the following commands in a separate terminal:'));
            console.log(chalk.cyan('  ./script/reset-engine engine-1 --reset-meta'));
            console.log(chalk.cyan('  ./script/reset-engine engine-2 --reset-meta'));
            console.log(chalk.yellow('====================================================================='));
            await question('Press Enter to confirm the engines have been reset...');
        }

        // Establish connection if starting from a later stage
        if (startAtStage >= 3) {
            console.log(chalk.blue(`\nStarting at stage ${startAtStage}, ensuring connection to engine(s)...`));
            const connectCommand = (startAtStage >= 7) ? 'connect engine-1 engine-2' : 'connect engine-1';
            await handleCommand(commands, null, 'engine', connectCommand);
            console.log("  - Waiting for initial sync...");
            if (testContext.storeHandle) {
                try {
                    await pEvent(testContext.storeHandle, 'change', { timeout: 20000 });
                    console.log(chalk.green("  - Initial sync complete."));
                } catch (e) {
                    console.log(chalk.yellow("  - Timed out waiting for initial sync, continuing..."));
                }
            }
        }
    });

    after(() => {
        console.log("Cleaning up all connections after tests...");
        if (testContext.repo) {
            handleCommand(commands, testContext.storeHandle!, 'engine', 'disconnect');
        }
    });

    // Dynamically generate tests from the selected sequence
    testSequence.forEach(testStep => {
        if (testStep.stage < startAtStage) {
            it.skip(`Stage ${testStep.stage}: ${testStep.description}`, () => { });
        } else {
            it(`Stage ${testStep.stage}: ${testStep.description}`, async function () {
                if (testStep.manualInstruction) {
                    this.timeout(0);
                } else {
                    this.timeout(120000);
                }

                if (testStep.manualInstruction) {
                    console.log(chalk.cyan(`\nMANUAL ACTION REQUIRED: ${testStep.manualInstruction}`));
                    await question('Press Enter to continue once the action is complete...');
                }

                if (testStep.action) {
                    const action = testStep.action;

                    if (action.type === 'sendCommand' && action.command === 'reboot') {
                        const store = testContext.storeHandle?.doc();
                        if (store) {
                            const targetEngine = getRunningEngines(store).find(e => e.hostname === action.targetEngineName);
                            if (targetEngine) {
                                console.log(chalk.yellow(`  - Storing pre-reboot state for ${action.targetEngineName}`));
                                preRebootState[action.targetEngineName] = {
                                    lastBooted: targetEngine.lastBooted,
                                    lastRun: targetEngine.lastRun
                                };
                                rebootTimers[action.targetEngineName] = Date.now();
                            }
                        }
                    }
                    await executeAction(action);
                }
                console.log(chalk.blue("Verifying assertions..."));
                let lastError: Error | undefined;
                for (let i = 0; i < 15; i++) { // Poll for up to 15 seconds
                    try {
                        for (const assertion of testStep.assert) {
                            const actualValue = await getValueFromPath(assertion.path);
                            executeAssertion(actualValue, assertion.should);
                        }
                        lastError = undefined;
                        break; // All assertions passed
                    } catch (e: any) {
                        lastError = e;
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }

                if (lastError) {
                    console.error(chalk.red(`Assertion failed after polling: ${lastError.message}`));
                    throw lastError;
                }

                console.log(chalk.green("  - All assertions passed."));
            });
        }
    });
});