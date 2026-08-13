/** Owned Codex App Server process and JSONL connection. */

import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { object, thrown } from './validation.ts'

/** One App Server notification in arrival order. */
export interface AppServerNotification {
  readonly method: string
  readonly params: Record<string, unknown>
}

/** Handler for an App Server request that requires a client response. */
export type AppServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

/** Synchronous connection observations used to preserve inbound wire ordering. */
export interface AppServerConnectionObserver {
  readonly notification: (notification: AppServerNotification) => void
  readonly failure: (error: Error) => void
}

class NotificationQueue implements AsyncIterable<AppServerNotification> {
  private readonly values: AppServerNotification[] = []
  private readonly waiters: Array<PromiseWithResolvers<IteratorResult<AppServerNotification>>> = []
  private terminal: { readonly error?: Error } | undefined

  push(value: AppServerNotification): void {
    if (this.terminal !== undefined) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  end(): void {
    this.settle({})
  }

  fail(error: Error): void {
    this.settle({ error })
  }

  private settle(terminal: { readonly error?: Error }): void {
    if (this.terminal !== undefined) return
    this.terminal = terminal
    for (const waiter of this.waiters.splice(0)) {
      if (terminal.error === undefined) waiter.resolve({ done: true, value: undefined })
      else waiter.reject(terminal.error)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AppServerNotification> {
    return {
      next: (): Promise<IteratorResult<AppServerNotification>> => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.terminal?.error !== undefined) return Promise.reject(this.terminal.error)
        if (this.terminal !== undefined) return Promise.resolve({ done: true, value: undefined })
        const waiter = Promise.withResolvers<IteratorResult<AppServerNotification>>()
        this.waiters.push(waiter)
        return waiter.promise
      },
    }
  }
}

/** One initialized or initializing App Server child. */
export class CodexAppServerConnection {
  private readonly transport: JsonRpcLineTransport
  private readonly queue = new NotificationQueue()
  private closing = false

  constructor(
    private readonly child: SubprocessHandle,
    requestHandler: AppServerRequestHandler,
    private readonly observer?: AppServerConnectionObserver,
  ) {
    if (child.stdout === undefined || child.stdin === undefined) {
      throw new Error('codex-plugin-dsh: App Server subprocess requires piped stdin and stdout')
    }
    this.transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    this.transport.onRequest(requestHandler)
    this.transport.onNotification((method, params) => {
      const notification = { method, params }
      if (this.observer === undefined) this.queue.push(notification)
      else this.observer.notification(notification)
    })
    void child.done.then(
      outcome => {
        if (this.closing) return
        const error = new Error(
          `codex-plugin-dsh: App Server exited unexpectedly (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderrSuffix()}`,
        )
        if (this.observer === undefined) this.queue.fail(error)
        else this.observer.failure(error)
      },
      error => {
        if (this.closing) return
        const failure = thrown(error)
        if (this.observer === undefined) this.queue.fail(failure)
        else this.observer.failure(failure)
      },
    )
  }

  /** Attach protocol listeners and perform the required initialize handshake. */
  async initialize(signal: AbortSignal): Promise<void> {
    this.transport.start()
    object(await this.transport.request('initialize', {
      clientInfo: {
        name: 'codex-plugin-dsh',
        title: 'Codex Plugin for DeepSeek Harness',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, signal), 'initialize response')
    this.transport.notify('initialized', {})
    await this.transport.flush()
  }

  /** Send one typed-by-caller App Server request. */
  async request(method: string, params: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    return object(await this.transport.request(method, params, signal), `${method} response`)
  }

  /** Send a best-effort interrupt for an active turn. */
  interrupt(threadId: string, turnId: string): void {
    if (this.closing) return
    void this.transport.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }

  /** Notifications emitted by this single-operation connection. */
  notifications(): AsyncIterable<AppServerNotification> {
    return this.queue
  }

  /** Terminate the managed process tree and wait until it is gone. Idempotent. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.queue.end()
    this.transport.close()
    try {
      this.child.stdin?.end()
    } catch {
      // Concurrent process closure leaves tree termination below authoritative.
    }
    this.child.terminate()
    await this.child.waitForExit()
    await this.child.done.catch(() => {})
  }

  private stderrSuffix(): string {
    const read = this.child.collected.stderr?.readFrom(0)
    const text = read?.text.trim()
    return text === undefined || text.length === 0 ? '' : `: ${text}`
  }
}
