import { DocHandle, Repo } from "@automerge/automerge-repo";
import { Store } from "./Store.js";

interface TestContext {
    repo: Repo | undefined;
    storeHandle: DocHandle<Store> | undefined;
}

/**
 * A shared context object for the test runner.
 * The 'connect' and 'disconnect' commands will populate this object,
 * and the test runner will use it to access the repo and store handle for assertions.
 */
export const testContext: TestContext = {
    repo: undefined,
    storeHandle: undefined,
};
