import {spawn, ChildProcess} from 'child_process'
import kill from 'tree-kill'
import {v4 as uuidv4} from 'uuid'
import * as core from '@actions/core'
import {setCheckRunOutput} from './output'
import * as os from 'os'
import chalk from 'chalk'

const color = new chalk.Instance({level: 1})

export type TestComparison = 'exact' | 'included' | 'regex'

export interface Test {
  readonly name: string
  readonly setup: string
  readonly run: string
  readonly input?: string
  readonly output?: string
  readonly timeout: number
  readonly points?: number
  readonly extra?: boolean
  readonly comparison: TestComparison
}

export class TestError extends Error {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, TestError)
  }
}

export class TestTimeoutError extends TestError {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, TestTimeoutError)
  }
}

export class TestOutputError extends TestError {
  expected: string
  actual: string

  constructor(message: string, expected: string, actual: string) {
    super(`${message}\nExpected:\n${expected}\nActual:\n${actual}`)
    this.expected = expected
    this.actual = actual

    Error.captureStackTrace(this, TestOutputError)
  }
}

const log = (text: string): void => {
  process.stdout.write(text + os.EOL)
}

const normalizeLineEndings = (text: string): string => {
  return text.replace(/\r\n/gi, '\n').trim()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const indent = (text: any): string => {
  let str = '' + new String(text)
  str = str.replace(/\r\n/gim, '\n').replace(/\n/gim, '\n  ')
  return str
}

const waitForExit = async (child: ChildProcess, timeout: number): Promise<void> => {
  // eslint-disable-next-line no-undef
  return new Promise((resolve, reject) => {
    let timedOut = false

    const exitTimeout = setTimeout(() => {
      timedOut = true
      reject(new TestTimeoutError(`Setup timed out in ${timeout} milliseconds`))
      if (typeof child.pid === 'number') kill(child.pid)
    }, timeout)

    child.once('exit', (code: number, signal: string) => {
      if (timedOut) return
      clearTimeout(exitTimeout)

      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new TestError(`Error: Exit with code: ${code} and signal: ${signal}`))
      }
    })

    child.once('error', (error: Error) => {
      if (timedOut) return
      clearTimeout(exitTimeout)

      reject(error)
    })
  })
}

const runSetup = async (test: Test, cwd: string, timeout: number): Promise<void> => {
  if (!test.setup || test.setup === '') {
    return
  }

  const setup = spawn(test.setup, {
    cwd,
    shell: true,
    env: {
      PATH: process.env['PATH'],
      FORCE_COLOR: 'true',
    },
  })

  // Start with a single new line
  process.stdout.write(indent('\n'))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup.stdout.on('data', (chunk) => {
    process.stdout.write(indent(chunk))
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup.stderr.on('data', (chunk) => {
    process.stderr.write(indent(chunk))
  })

  await waitForExit(setup, timeout)
}

const runCommand = async (test: Test, cwd: string, timeout: number): Promise<void> => {
  const child = spawn(test.run, {
    cwd,
    shell: true,
    env: {
      PATH: process.env['PATH'],
      FORCE_COLOR: 'true',
    },
  })

  let output = ''

  // Start with a single new line
  process.stdout.write(indent('\n'))

  child.stdout.on('data', (chunk) => {
    process.stdout.write(indent(chunk))
    output += chunk
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(indent(chunk))
  })

  // Preload the inputs
  if (test.input && test.input !== '') {
    child.stdin.write(test.input)
    child.stdin.end()
  }

  await waitForExit(child, timeout)

  // Eventually work off the test type
  if ((!test.output || test.output == '') && (!test.input || test.input == '')) {
    return
  }

  const expected = normalizeLineEndings(test.output || '')
  const actual = normalizeLineEndings(output)

  const diffMessage = (actual: string, expected: string): void => {
    let linesActual = actual.split(/\r?\n/)
    let linesExpected = expected.split(/\r?\n/)
    let minLines = Math.min(linesActual.length, linesExpected.length)

    log(``)
    log(`Num lines expected ` + linesExpected.length)
    log(`  Num lines actual ` + linesActual.length)

    let cActual = ``
    let cExpected = ``
    let expectedLine = ``
    let actualLine = ``

    log(``)
    // Look at each line
    for (var i = 0; i < minLines; i++) {

      expectedLine = linesExpected[i]
      actualLine = linesActual[i]

      if (actualLine == expectedLine) {
        log(color.green(`Line ` + i + `\tExpected: "` + expectedLine + `\\n"`))
        log(color.green(`Line ` + i + `\t  Actual: "` + actualLine + `\\n"`))
      } else {
        log(color.red(`------- Mismatch on line ` + i))
        const diff = [...expectedLine];
        for (let j = 0; j < expectedLine.length; j++) {
          if (actualLine[j] != expectedLine[j]) {
            cActual = actualLine[j];
            cExpected = expectedLine[j];
            diff[j] = `^`;
          } else {
            diff[j] = `_`;
          }
        }

        let diffLine = diff.join('')
        log(``);
        log(color.red(`EXPECTED: "` + expectedLine + `"`));
        log(color.red(`  ACTUAL: "` + actualLine + `"`));
        log(color.red(`           ` + diffLine));
        log(``);
        if (expectedLine.length >= actualLine.length) {
          log(color.red(`Character '` + cActual + `' does not match expected character '` + cExpected + `'`));
          log(``);
        }
        log(color.red(`Note: If both lines look the same, then it could be the an`));
        log(color.red(`invisible whitespace such as a tab or newline. Highlighting`));
        log(color.red(`and/or copying each line could help you figure out if there`));
        log(color.red(`are hidden whitespace characters.`));
        return;
      }
    }

    if (linesActual.length < linesExpected.length) {
      log(``)
      log(color.red(`Your program is missing output.`));
      log(``)
      log(color.red(`Missing output: "` + linesExpected[i] + `"`));
    } else if (linesActual.length > linesExpected.length) {
      log(``)
      log(color.red(`Extra output found in your program output.`));
      log(``)
      log(color.red(`Extra output: "` + linesActual[i] + `"`));
    }
  }

  switch (test.comparison) {
    case 'exact':
      if (actual != expected) {
        diffMessage(actual, expected)
        throw new TestError(`Output does not match`)
        // throw new TestOutputError(`The output for test ${test.name} did not match`, expected, actual)
      }
      break
    case 'regex':
      // Note: do not use expected here
      if (!actual.match(new RegExp(test.output || ''))) {
        throw new TestOutputError(`The output for test ${test.name} did not match`, test.output || '', actual)
      }
      break
    default:
      // The default comparison mode is 'included'
      if (!actual.includes(expected)) {
        throw new TestOutputError(`The output for test ${test.name} did not match`, expected, actual)
      }
      break
  }
}

export const run = async (test: Test, cwd: string): Promise<void> => {
  // Timeouts are in minutes, but need to be in ms
  let timeout = (test.timeout || 1) * 60 * 1000 || 30000
  const start = process.hrtime()
  await runSetup(test, cwd, timeout)
  const elapsed = process.hrtime(start)
  // Subtract the elapsed seconds (0) and nanoseconds (1) to find the remaining timeout
  timeout -= Math.floor(elapsed[0] * 1000 + elapsed[1] / 1000000)
  await runCommand(test, cwd, timeout)
}

export const runAll = async (tests: Array<Test>, cwd: string): Promise<void> => {
  let points = 0
  let availablePoints = 0
  let hasPoints = false

  // https://help.github.com/en/actions/reference/development-tools-for-github-actions#stop-and-start-log-commands-stop-commands
  const token = uuidv4()
  log('')
  log(`::stop-commands::${token}`)
  log('')

  let failed = false

  for (const test of tests) {
    try {
      if (test.points) {
        hasPoints = true
        if (!test.extra) {
          availablePoints += test.points
        }
      }
      log(color.cyan(`📝 ${test.name}`))
      log('')
      await run(test, cwd)
      log('')
      log(color.green(`✅ completed - ${test.name}`))
      log(``)
      if (test.points) {
        points += test.points
      }
    } catch (error) {
      log('')
      log(color.red(`❌ failed - ${test.name}`))
      if (!test.extra) {
        failed = true
        if (error instanceof Error) {
          core.setFailed(error.message)
        } else {
          core.setFailed(`Failed to run test '${test.name}'`)
        }
      }
    }
  }

  // Restart command processing
  log('')
  log('Finished testing')
  log(`::${token}::`)

  if (failed) {
    // We need a good failure experience
    log('')
    log(color.red('Oh noes!  Some tests failed!'))
    log('')
  } else {
    log('')
    log(color.green('All tests passed'))
    log('✨🌟💖💎🦄💎💖🌟✨🌟💖💎🦄💎💖🌟✨')
    log('')
  }

  if (points > availablePoints) {
    const extraCreditPoints = 1 * (points - availablePoints)
    log(`💪💪💪 You earned ${extraCreditPoints} extra credit points`)
    log('')
  }

  // Set the number of points
  if (hasPoints) {
    const text = `Points ${points}/${availablePoints}`
    log(color.bold.bgCyan.black(text))
    core.setOutput('Points', `${points}/${availablePoints}`)
    await setCheckRunOutput(text)
  }
}
