import type { ServerInfo, ZcrxProbe } from './native'

export type ZcrxSmokeStatus = 'running' | 'self-test' | 'skipped' | 'passed' | 'failed'
export type ZcrxSmokeCaseStatus = 'running' | 'passed' | 'failed'

export interface ZcrxSmokeOptions {
  interfaceName?: string
  rxQueue?: number | string
  rxBufferSize?: number | string
  bindHost?: string
  connectHost?: string
  timeoutMs?: number | string
  requireRxQueueStats?: boolean
  reportPath?: string
  selfTest?: boolean
}

export interface ZcrxSmokeError {
  name: string
  message: string
  stack?: string
}

export interface ZcrxQueueCounterSnapshot {
  available: boolean
  reason: string | null
  counters: Record<string, string>
}

export interface ZcrxQueueCounterDelta {
  name: string
  delta: string
}

export interface ZcrxQueueCounterReport {
  before: ZcrxQueueCounterSnapshot
  after: ZcrxQueueCounterSnapshot | null
  positiveDeltas: Array<ZcrxQueueCounterDelta>
}

export interface ZcrxSmokeCaseReport {
  name: 'http' | 'native-echo' | 'programmable-tcp' | string
  status: ZcrxSmokeCaseStatus
  startInfo: ServerInfo
  finalInfo: ServerInfo | null
  response: unknown
  error: ZcrxSmokeError | null
}

export interface ZcrxSmokeReport {
  status: ZcrxSmokeStatus
  startedAt: string
  finishedAt: string | null
  config: {
    interfaceName?: string
    rxQueue: number
    rxBufferSize: number
    bindHost: string
    connectHost: string
    connectHostExplicit: boolean
    connectHostSource: 'option' | 'env' | 'default'
    timeoutMs: number
    requireRxQueueStats: boolean
  }
  warnings: Array<string>
  skippedReason?: string
  probe: ZcrxProbe | null
  queueCounters: ZcrxQueueCounterReport | null
  smokes: Array<ZcrxSmokeCaseReport>
  error?: ZcrxSmokeError
}

export declare function runQueueStatsParserSelfTest(): void
export declare function runZcrxHardwareSmoke(
  options?: ZcrxSmokeOptions
): Promise<ZcrxSmokeReport>

declare const zcrxSmoke: {
  runQueueStatsParserSelfTest: typeof runQueueStatsParserSelfTest
  runZcrxHardwareSmoke: typeof runZcrxHardwareSmoke
}

export default zcrxSmoke
