import { Suite, Runner } from 'mocha'
import Mocha from 'mocha';
import { print } from './utils/utils.js';

// First, you need to instantiate a Mocha instance

var mocha = new Mocha({
    reporter: 'list'
});

//mocha.reporter('xunit', { output: './test/testspec.xunit.xml' });

var suite = new Suite('JSON suite');
var runner = new Runner(suite);
//var xunit = new XUnit(runner);
//var mochaReporter = new mocha._reporter(runner);

mocha.addFile(
    './dist/test/01 - index.js'
);

mocha.addFile(
    './dist/test/02 - local-engine.js'
);

runner.run(function(failures) {
    // the json reporter gets a testResults JSON object on end
    //var testResults = mochaReporter.testResults;

    //was-console-log(testResults);
    // send your email here
    print('done')
});