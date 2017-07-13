
import * as Fs from 'fs';
import * as Path from 'path';

import {readFile, writeFile, fileExists, readDirRecursive, indent, shell, mkdirp} from './Util';
//import {getDerivedConfigsForDir} from './ReadConfigs';
import commandLineArgs from './CommandLineArgs';
import parseTestFile, {ParsedTestFile} from './ParseTestFile';

try {
    require('source-map-support');
} catch (e) { }

type TestResult = TestSuccess | TestFailure;

interface Test {
    testDir: string
    expectedTxtFilename: string
    expected: ParsedTestFile | null
    originalCommand: string
    command: string
    result: TestResult

    actualLines: string[]
    actualStderrLines: string[]
    actualExitCode: number
}

interface TestSuccess {
    result: 'success'
}

interface TestFailure {
    result: 'failure'
    details: string
}

async function findTestsForTarget(target:string) {
    const tests = [];
    for (const file of await readDirRecursive(target)) {
        if (Path.basename(file) === 'expected.txt') {
            tests.push(Path.dirname(file));
        }
    }
    return tests;
}

async function loadExpectedFile(test:Test) : Promise<Test> {
    const args = commandLineArgs();

    if (args.accept) {
        // when --accept is used, don't read expected.txt at all.
        return test;
    }

    const expectedOutput : string|null = await readFile(test.expectedTxtFilename).catch(() => null);
    if (!expectedOutput) {
        return test;
    }
    
    const parsed = parseTestFile(expectedOutput);
    test.expected = parsed;
    return test;
}

function loadCommand(test: Test) : Test {
    const args = commandLineArgs();

    test.originalCommand = args.command || test.expected.command;
    test.command = test.originalCommand;

    // Template strings
    test.command = test.command.replace(/\{testDir\}/g, test.testDir);

    return test;
}

async function runTestCommand(test: Test) : Promise<Test> {

    const command = test.command;
    const args = commandLineArgs();

    if (!command) {
        test.result = {
            result: 'failure',
            details: `Missing command (use --command flag to set one)`
        };
        return test;
    }

    console.log(`Running: ${command}`);

    const shellResult = await shell(command);

    const actualOutput = shellResult.stdout;
    test.actualLines = actualOutput.split('\n');

    if (shellResult.stderr) {
        test.actualStderrLines = shellResult.stderr.split('\n');
    }

    if (shellResult.error) {
        test.actualExitCode = shellResult.error.code;
    } else {
        test.actualExitCode = 0;
    }

    /*
    if (shellResult.error && !args.expect_error) {

        const exitCode = shellResult.error.code;

        if (exitCode !== 0) {
            test.result = {
                result: 'failure',
                details: `Command: ${test.command}\nExited with non-zero code: ${exitCode}`
            }
            return test;
        }

        test.result = {
            result: 'failure',
            details: `Command ${test.command} had error:\n${shellResult.error}`
        }
        return test;
    }

    if (args.expect_error && !shellResult.error) {
        test.result = {
            result: 'failure',
            details: `Command ${test.command} didn't error, but 'expect_error' is on.`
        }
        return test;
    }
    */

    return test;
}

function testBackToExpectedString(test:Test) {
    let out = ' $ ' + test.originalCommand + '\n' + test.actualLines.join('\n');
    if (test.actualExitCode !== 0) {
        out += ' # exit code: ' + test.actualExitCode + '\n';
    }
    return out;
}

async function acceptOutput(test:Test) : Promise<void> {
    await mkdirp(test.testDir);
    await writeFile(test.expectedTxtFilename, testBackToExpectedString(test));
    console.log(`Saved output to: ${test.expectedTxtFilename}`);
}

function checkExpectedOutput(test:Test) : Test {
    const actualLines = test.actualLines;
    const expectedLines = test.expected.lines;

    const maxLineNumber = Math.max(actualLines.length, expectedLines.length);

    for (let lineNumber = 0; lineNumber < maxLineNumber; lineNumber++) {
        let actualLine = actualLines[lineNumber];
        let expectedLine = expectedLines[lineNumber];

        if (actualLine !== expectedLine) {
            test.result = {
                result: 'failure',
                details: `Line ${lineNumber} didn't match expected output:\n`
                    +`Expected: ${expectedLine}\n`
                    +`Actual:   ${actualLine}`
            }
            return;
        }
    }

    if (test.actualExitCode !== test.expected.exitCode) {
        if (test.expected.exitCode === 0) {
            test.result = {
                result: 'failure',
                details: `Command: ${test.command}\nExited with non-zero code: ${test.actualExitCode}`
            }
            return test;
        }

        test.result = {
            result: 'failure',
            details: `Command: ${test.command}\nProcess exit code didn't match expected:\n`
                    +`Expected exit code: ${test.expected.exitCode}\n`
                    +`Actual exit code:   ${test.actualExitCode}`
        }
        return test;
    }

    test.result = {
        result: 'success'
    };

    return test;
}

async function runOneTest(test:Test) : Promise<Test> {
    const args = commandLineArgs();

    await loadExpectedFile(test);
    loadCommand(test);
    await runTestCommand(test);

    if (args.showOutput) {
        console.log("Output:");
        for (const line of test.actualLines)
            console.log('  ' + line);
    }

    if (args.accept) {
        await acceptOutput(test);
    } else {
        checkExpectedOutput(test);
    }

    return test;
}

function reportTestResults(tests : Test[]) {

    let anyFailed = false;

    for (const test of tests) {
        if (!test.result) {
            console.log("internal error: test has no result: ", test);
            throw new Error("internal error: test has no result: ");
        }

        if (test.result.result === 'success') {
            console.log('Test passed: '+ test.testDir);
        } else if (test.result.result === 'failure') {
            console.log('Test failed: '+ test.testDir);
            console.log(indent(test.result.details));
            anyFailed = true;
        }
    }

    if (anyFailed) {
        process.exitCode = -1;
    }
    
}

export async function run() {

    const args = commandLineArgs();

    let allTests = [];

    /*
    for (const target of args.targetDirectories) {
        const targetTests = await findTestsForTarget(target);
        allTests = allTests.concat(targetTests);
    }
    */

    const tests:Test[] = await Promise.all(
        args.targetDirectories.map((dir) => {

            // Normalize directory.. no trailing slash.
            if (dir[dir.length - 1] === '/')
                dir = dir.substr(0, dir.length - 1);

            const test : Test = {
                testDir: dir,
                expectedTxtFilename: Path.join(dir, 'expected.txt'),
                expected: null,
                originalCommand: null,
                command: null,
                result: null,
                actualLines: [],
                actualStderrLines: [],
                actualExitCode: null
            };
            
            return runOneTest(test);
        })
    );

    if (!args.accept) {
        reportTestResults(tests);
    }
}

function commandLineStart() {
    run()
    .catch((err) => {
        process.exitCode = 1;
        console.log(err);
    });
}

exports.commandLineStart = commandLineStart;
