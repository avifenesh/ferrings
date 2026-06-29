import {
  IoUringTcpConnection,
  IoUringTcpTransportServer,
  IoUringTlsTransportServer,
  UringHttpServer,
  UringTcpEchoServer,
  UringTcpServer,
  capabilities,
  createTcpServer,
  createTlsServer,
  zcrxProbe,
  type Capabilities,
  type IoUringTlsServerOptions,
  type ServerInfo,
  type ServerOptions,
  type TcpEvent,
  type TcpSend,
  type TcpServerOptions,
  type ZcrxProbe,
  type ZcrxProbeOptions
} from '../index';
import createTcpTransportExports, {
  type TcpTransportExports
} from '../tcp-transport';
import zcrxSmoke, {
  runZcrxHardwareSmoke,
  type ZcrxSmokeReport
} from '../zcrx-smoke';

const tcpOptions: TcpServerOptions = {
  host: '127.0.0.1',
  port: 0,
  backlog: 1024,
  queueDepth: 64,
  bufferCount: 512,
  bufferSize: 2048,
  maxConnections: 1024,
  idleTimeoutMs: 1000,
  tcpNoDelay: true,
  reusePort: false,
  tcpDeferAcceptSeconds: 0,
  socketRecvBufferSize: 0,
  socketSendBufferSize: 0,
  commandQueueCapacity: 1024,
  eventQueueCapacity: 1024,
  eventBatchSize: 64,
  sendQueueCapacity: 256,
  useRegisteredSendBuffer: false,
  useRecvBundle: true,
  useZeroCopySend: true,
  sendBufferCount: 256,
  sendBufferSize: 2048,
  useZeroCopyReceive: false,
  zcrxInterfaceName: 'eth0',
  zcrxRxQueue: 0,
  zcrxRxBufferSize: 0
};

const server: IoUringTcpTransportServer = createTcpServer(
  tcpOptions,
  (connection: IoUringTcpConnection) => {
    const wrote: boolean = connection.write(new Uint8Array([1, 2, 3]));
    const ended: boolean = connection.end('done');
    const remotePort: number | undefined = connection.remotePort;
    const remoteFamily: 'IPv4' | 'IPv6' | undefined = connection.remoteFamily;
    void wrote;
    void ended;
    void remotePort;
    void remoteFamily;
  }
);

server.on('connection', (connection) => connection.write('hello'));
server.on('data', (connection, data) => {
  connection.write(data);
  server.sendBatch([{ connection, data }]);
});
server.on('connectionClose', (connection) => {
  const destroyed: boolean = connection.destroyed;
  void destroyed;
});
server.listen(0, '127.0.0.1', 1024, (info: ServerInfo) => {
  const port: number = info.port;
  const backend: string = info.backend;
  void port;
  void backend;
});

server.getConnections((err: Error | null, count: number) => {
  void err;
  void count;
});

const address = server.address();
if (address) {
  const family: 'IPv4' | 'IPv6' = address.family;
  void family;
}

const facadeSendAccepted: boolean = server.sendBatch([
  { connectionId: 1, data: Buffer.from('one') },
  { connectionId: 2, data: new Uint8Array([1, 2]) }
]);
const facadeCloseAccepted: boolean = server.sendBatchAndClose([
  { connectionId: 3, data: 'three' }
]);
void facadeSendAccepted;
void facadeCloseAccepted;

const tlsOptions: IoUringTlsServerOptions = {
  key: Buffer.from('key'),
  cert: Buffer.from('cert'),
  host: '127.0.0.1',
  port: 0,
  ALPNProtocols: ['h2', 'http/1.1'],
  handshakeTimeout: 1000,
  tcp: {
    useZeroCopySend: true
  }
};
const tlsServer: IoUringTlsTransportServer = createTlsServer(tlsOptions, (connection) => {
  const authorized: boolean = connection.authorized;
  connection.write('secure');
  void authorized;
});
tlsServer.on('secureConnection', (connection) => {
  connection.end('done');
});
tlsServer.on('tlsClientError', (error, connection) => {
  const encrypted: boolean = connection.encrypted;
  void error;
  void encrypted;
});
tlsServer.listen(0, '127.0.0.1', (info: ServerInfo) => {
  const port: number = info.port;
  void port;
});

const raw = new UringTcpServer(tcpOptions);
const rawInfo: ServerInfo = raw.start((event: TcpEvent) => {
  if (event.data) {
    raw.send(event.connectionId, event.data);
  }
});
const rawBatchInfo: ServerInfo = new UringTcpServer(tcpOptions).startBatch(
  (events: Array<TcpEvent>) => {
    const sends: Array<TcpSend> = events
      .filter((event) => event.data)
      .map((event) => ({
        connectionId: event.connectionId,
        data: event.data ?? Buffer.alloc(0)
      }));
    raw.sendBatchAndClose(sends);
  }
);
raw.closeConnection(1);
raw.stop();
void rawInfo;
void rawBatchInfo;

const httpOptions: ServerOptions = {
  host: '127.0.0.1',
  port: 0,
  responseBody: 'ok',
  useZeroCopySend: true
};
const http = new UringHttpServer(httpOptions);
const echo = new UringTcpEchoServer(tcpOptions);
const httpInfo: ServerInfo | null = http.info();
const echoInfo: ServerInfo | null = echo.info();
void httpInfo;
void echoInfo;

const caps: Capabilities = capabilities();
const ioUringReady: boolean = caps.ioUringAvailable;
void ioUringReady;

const zcrxOptions: ZcrxProbeOptions = {
  interfaceName: 'eth0',
  rxQueue: 0,
  activeRegistration: false
};
const probe: ZcrxProbe = zcrxProbe(zcrxOptions);
const blockers: Array<string> = probe.blockers;
void blockers;

const transportFactory: (server: typeof UringTcpServer) => TcpTransportExports =
  createTcpTransportExports;
const smokeReportPromise: Promise<ZcrxSmokeReport> = runZcrxHardwareSmoke({
  selfTest: true,
  timeoutMs: 1000
});
const defaultSmoke: typeof runZcrxHardwareSmoke = zcrxSmoke.runZcrxHardwareSmoke;
void transportFactory;
void smokeReportPromise;
void defaultSmoke;
