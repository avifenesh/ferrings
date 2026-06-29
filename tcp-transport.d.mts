import { EventEmitter } from 'node:events'
import type { TLSSocket, TlsOptions } from 'node:tls'
import type { ServerInfo, TcpServerOptions, UringTcpServer as NativeUringTcpServer } from './native.js'

export interface IoUringTcpConnection extends EventEmitter {
  readonly id: number
  readonly remoteAddress?: string
  readonly remoteFamily?: 'IPv4' | 'IPv6'
  readonly remotePort?: number
  readonly destroyed: boolean
  write(data: Buffer | string | Uint8Array): boolean
  end(data?: Buffer | string | Uint8Array): boolean
  destroy(): boolean
  on(event: 'data', listener: (data: Buffer) => void): this
  on(event: 'close', listener: () => void): this
  on(event: string | symbol, listener: (...args: Array<any>) => void): this
}

export interface IoUringTcpConnectionConstructor {
  readonly prototype: IoUringTcpConnection
}

export interface IoUringTcpTransportServer extends EventEmitter {
  start(callback?: (info: ServerInfo) => unknown): ServerInfo
  start(options?: TcpServerOptions | undefined | null, callback?: (info: ServerInfo) => unknown): ServerInfo
  listen(callback?: (info: ServerInfo) => unknown): this
  listen(options?: TcpServerOptions | undefined | null, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, host: string, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, host: string, backlog: number, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, backlog: number, callback?: (info: ServerInfo) => unknown): this
  close(callback?: () => unknown): this
  stop(): void
  info(): ServerInfo | null
  address(): { address: string, family: 'IPv4' | 'IPv6', port: number } | null
  connections(): Array<IoUringTcpConnection>
  getConnections(callback: (err: Error | null, count: number) => unknown): this
  sendBatch(sends: Array<IoUringTcpBatchSend>): boolean
  sendBatchAndClose(sends: Array<IoUringTcpBatchSend>): boolean
  ref(): this
  unref(): this
  on(event: 'connection', listener: (connection: IoUringTcpConnection) => void): this
  on(event: 'listening', listener: (info: ServerInfo) => void): this
  on(event: 'data', listener: (connection: IoUringTcpConnection, data: Buffer) => void): this
  on(event: 'connectionClose', listener: (connection: IoUringTcpConnection) => void): this
  on(event: 'close', listener: () => void): this
  on(event: string | symbol, listener: (...args: Array<any>) => void): this
}

export interface IoUringTcpTransportServerConstructor {
  new(
    options?: TcpServerOptions | undefined | null,
    connectionListener?: (connection: IoUringTcpConnection) => unknown
  ): IoUringTcpTransportServer
  new(connectionListener?: (connection: IoUringTcpConnection) => unknown): IoUringTcpTransportServer
  readonly prototype: IoUringTcpTransportServer
}

export type IoUringTlsServerOptions =
  Omit<TlsOptions, keyof TcpServerOptions | 'server'> &
  TcpServerOptions & {
    tcp?: TcpServerOptions | undefined
    transport?: TcpServerOptions | undefined
  }

export interface IoUringTlsTransportServer extends EventEmitter {
  start(callback?: (info: ServerInfo) => unknown): ServerInfo
  start(options?: TcpServerOptions | undefined | null, callback?: (info: ServerInfo) => unknown): ServerInfo
  listen(callback?: (info: ServerInfo) => unknown): this
  listen(options?: TcpServerOptions | undefined | null, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, host: string, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, host: string, backlog: number, callback?: (info: ServerInfo) => unknown): this
  listen(port: number, backlog: number, callback?: (info: ServerInfo) => unknown): this
  close(callback?: () => unknown): this
  stop(): void
  info(): ServerInfo | null
  address(): { address: string, family: 'IPv4' | 'IPv6', port: number } | null
  connections(): Array<TLSSocket>
  getConnections(callback: (err: Error | null, count: number) => unknown): this
  ref(): this
  unref(): this
  on(event: 'secureConnection', listener: (connection: TLSSocket) => void): this
  on(event: 'tlsClientError', listener: (error: Error, connection: TLSSocket) => void): this
  on(event: 'clientError', listener: (error: Error, connection: TLSSocket) => void): this
  on(event: 'listening', listener: (info: ServerInfo) => void): this
  on(event: 'close', listener: () => void): this
  on(event: string | symbol, listener: (...args: Array<any>) => void): this
}

export interface IoUringTlsTransportServerConstructor {
  new(
    options?: IoUringTlsServerOptions | undefined | null,
    secureConnectionListener?: (connection: TLSSocket) => unknown
  ): IoUringTlsTransportServer
  new(secureConnectionListener?: (connection: TLSSocket) => unknown): IoUringTlsTransportServer
  readonly prototype: IoUringTlsTransportServer
}

export type IoUringTcpBatchSend =
  | {
      connection: IoUringTcpConnection
      connectionId?: never
      data: Buffer | string | Uint8Array
    }
  | {
      connection?: never
      connectionId: number
      data: Buffer | string | Uint8Array
    }

export interface TcpTransportExports {
  IoUringTcpConnection: IoUringTcpConnectionConstructor
  IoUringTcpTransportServer: IoUringTcpTransportServerConstructor
  IoUringTlsTransportServer: IoUringTlsTransportServerConstructor
  createTcpServer(
    options?: TcpServerOptions | undefined | null,
    connectionListener?: (connection: IoUringTcpConnection) => unknown
  ): IoUringTcpTransportServer
  createTcpServer(
    connectionListener?: (connection: IoUringTcpConnection) => unknown
  ): IoUringTcpTransportServer
  createTlsServer(
    options?: IoUringTlsServerOptions | undefined | null,
    secureConnectionListener?: (connection: TLSSocket) => unknown
  ): IoUringTlsTransportServer
  createTlsServer(
    secureConnectionListener?: (connection: TLSSocket) => unknown
  ): IoUringTlsTransportServer
}

export default function createTcpTransportExports(
  UringTcpServer: typeof NativeUringTcpServer
): TcpTransportExports
