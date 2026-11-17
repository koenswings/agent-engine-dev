import { log } from './utils/utils.js';
import { startEngine } from "./start.js";
import { chalk } from "zx";
import { staleStoreExitPending } from './data/StaleDocGuard.js';

const main = async () => {
    try {
        await startEngine();
        log('++++++++++++++++++++++++++++++++++', 1);
        log('+++++++++ Engine started +++++++++', 1);
        log('++++++++++++++++++++++++++++++++++', 1);        
    } catch (error) {
        log(chalk.red('Error starting engine'));
        console.error(error);
        // engine#512: a stale store doc already started a clean exit with its own code (75)
        if (staleStoreExitPending()) return;
        process.exit(1); // Exit with an error code if startup fails
    }

    // Keep the process alive indefinitely so background services can run
    await new Promise(() => {});
};

main();