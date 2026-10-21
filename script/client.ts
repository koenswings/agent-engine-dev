#!/usr/bin/env zx
import { $, question, chalk, cd, argv, fs } from 'zx';
import * as readline from 'readline';
import { createClientStore, Store } from '../src/data/Store.js';
import { handleCommand } from '../src/utils/commandUtils.js';
import { commands } from '../src/data/Commands.js';

import pack from '../package.json' with { type: "json" }
//import { readDefaults, Defaults } from '../src/utils/readDefaults.js'
import { lookup } from 'dns/promises';
import { config } from '../src/data/Config.js'

import { DocumentId, PeerId } from '@automerge/automerge-repo';
import { localEngineId } from '../src/data/Engine.js';
import { readStoreDocId } from '../src/data/StoreIdentity.js';

// **********************
// Command-line arguments
// **********************

// Check for the help flag and print usage if help is requested
if (argv.h || argv.help) {
    console.log(`Starts a client process with a text-based command interface`)
    console.log(`Usage: client [options]`);
    // We have help, version, engine, network and port options
    console.log(`Options:`)
    console.log(`  -h, --help              display help for command`)  
    console.log(`  -v, --version           output the version number`)
    // console.log(`  -n, --network <string>  the network we want to join (default: ${defaults.network})`)
    console.log(`  -e, --engine <string>   the engine (address) we want to connect to (default: ${"127.0.1:1234"})`)
    //console.log(`  -i, --id <string>   the engine (id) we want to connect to (default: ${defaults.engineId})`)
    console.log(``)
    process.exit(0)
}

// Check for the version flag and print the version if requested
if (argv.v || argv.version) {
    console.log(`Version: ${pack.version}`)
    process.exit(0)
}


// ************************
// Connection to an engine
// ************************

const engineName = argv.e || argv.engine || "127.0.0.1";

// The `connect` command in `Commands.ts` prepares a hostname by appending `.local`
// and passes it to `createClientStore`. We replicate that exact logic here.
// `createClientStore` is responsible for the DNS lookup and connection.
const hostname = engineName.endsWith('.local') ? engineName : `${engineName}.local`;

const clientPeerId = `client-on-${localEngineId}` as PeerId; // Unique identifier for the client
const STORE_URL_PATH = "./store-identity/store-url.txt";
// readStoreDocId trims surrounding whitespace: a store-url.txt written with a trailing
// newline (e.g. `echo automerge:… > store-url.txt`) gave '<id>\n' and automerge-repo
// refused it with 'Invalid AutomergeUrl' (kind-panda, 2026-10-18).
const storeDocId: DocumentId = readStoreDocId(STORE_URL_PATH);
console.log(`Using document ID: ${storeDocId}`);

const { handle: storeHandle } = await createClientStore([hostname], clientPeerId, storeDocId);


const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Enter command: '
});

let commandHistory: string[] = [];


readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

rl.prompt();

rl.on('line', (line) => {
    const trimmedLine = line.trim();
    
    if (trimmedLine === 'exit') {
        rl.close();
        return;
    }

    if (trimmedLine) {
        commandHistory.push(trimmedLine); // Save the command to history
        handleCommand(commands, storeHandle, 'engine', trimmedLine); // Process the command
    }

    rl.prompt();
}).on('close', () => {
    console.log('Exiting command interpreter.');
    process.exit(0);
});
