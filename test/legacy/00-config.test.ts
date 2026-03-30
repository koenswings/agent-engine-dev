import { describe, it } from 'mocha';
import { expect } from 'chai';
import { config } from '../src/data/Config.js';

describe('Configuration Loading', () => {

    it('should successfully load and validate the config.yaml file at startup', () => {
        // By the time this test runs, the config object has already been imported and validated.
        // If the validation had failed, the process would have exited.
        // So, we just need to check that the imported config object is not null or undefined.
        expect(config).to.not.be.null;
        expect(config).to.not.be.undefined;
        expect(config).to.be.an('object');
        console.log("Config object was successfully loaded and validated at startup.");
    });

    it('should have a valid testSetup property', () => {
        expect(config.testSetup).to.be.an('object');
        expect(config.testSetup.engines).to.be.an('array');
    });

});