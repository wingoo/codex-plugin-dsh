import { describe, expect, it } from 'vitest'
import { codexAppServerInvocation } from '../src/adapter.ts'

describe('codexAppServerInvocation', () => {
  it('executes a POSIX binary directly', () => {
    expect(codexAppServerInvocation('/opt/homebrew/bin/codex', { CODEX_HOME: '/tmp/codex' }, 'darwin')).toEqual({
      argv: ['/opt/homebrew/bin/codex', 'app-server', '--stdio'],
      env: { CODEX_HOME: '/tmp/codex' },
    })
  })

  it('routes a Windows npm shim through a resolved command interpreter', () => {
    expect(codexAppServerInvocation(
      String.raw`C:\Users\Agent & Co\bin\codex.cmd`,
      { CODEX_HOME: String.raw`C:\Codex Home` },
      'win32',
      String.raw`C:\Windows\System32\cmd.exe`,
    )).toEqual({
      argv: [
        String.raw`C:\Windows\System32\cmd.exe`,
        '/d',
        '/v:off',
        '/s',
        '/c',
        '%DSH_CODEX_APP_SERVER_EXECUTABLE%',
        'app-server',
        '--stdio',
      ],
      env: {
        CODEX_HOME: String.raw`C:\Codex Home`,
        DSH_CODEX_APP_SERVER_EXECUTABLE: String.raw`"C:\Users\Agent & Co\bin\codex.cmd"`,
      },
    })
  })

  it('executes a native Windows binary directly', () => {
    expect(codexAppServerInvocation(String.raw`C:\Tools\codex.exe`, {}, 'win32')).toEqual({
      argv: [String.raw`C:\Tools\codex.exe`, 'app-server', '--stdio'],
      env: {},
    })
  })
})
