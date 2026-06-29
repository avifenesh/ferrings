'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const {
  IoUringTlsTransportServer,
  createTlsServer
} = require('../');

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC1hOnGWBQsu/1A
Km+Nv7Gav68MlHaQJyp78pjL93ZAYL6y23OJ9hyV7IGkSdrk4VuJpTr1eWZgsLat
OIk+ZvU1mWSvv5mXTKevTjSeUzqZb8eaqXA2JEf6b5mXguF9iipZa/A5veyY/LQ/
JmO24gKjcT55ufa1SntsteA7LBO3FtrIftY1MBOoCn6+Fjn8NT1a32s5AzIxaSnq
kHozVIdLy3I1JkIWotmOxtLEE2dv2vNjS+DfKS4VL+Ql2OcM5wv72ap9ZljbmrTV
ogUWIuKaQRrXaHPwd887pK4rTzgQFFoxUJ+d/hU+bsyUwDnV36fj3ivtHnI1eq4F
vmnomOz/AgMBAAECggEAEJp2WIDCYtxUxbBcAQcLJtC1VINyXBMvc3D1Gv5CrPbS
2qdW6F3aFYVkzyZv3qziY5lfTQhsURg45wIbdtkrp40+997UHLiTqf+PfpMcWOAw
ANMFnMSXm0ez/XdCSuplbBKC207Z1Z1fzo4jY51FIoNMQXQjv3qibLou8+dya8+3
dK2sc1FJ5Hf9YQ7Ggta6HoFmspDvnC2Rw2gdgIKlcWKjFypFmUDNAVvaEu91YR+x
TaWWm9grjdtpOcK/wiBOc1PlC4VB46fqrenO84YE7dihXzmJSH3tsK08Rw2Lnn2Q
GFbep9zWkt2yuiBhNU9R37ZYqEx7/9oXyqcD6VctUQKBgQDyUFYC2F/pAGxhBa2D
zDofkOULm5uqu9BXtpxHqtD4XttsVEuOT9fRmOpF5TUx/7KY3sCf71lEsxw28Hl5
HbOacxThcob1lJe4TRr0jnNGfsgDLO5nSKOScZbT1Ycvb3MMeYR8Uh24q/Ts0U91
2R+1nRJpHhRl3owSyTMCFVABtwKBgQC/xYkckWlOgwQPRoQ3D/EiOppy/L8TWz2A
xhzu9KMK4UjCzAzMAIfI/2qexen9jhLhW4AdIaQwsxB2Lg3f62xNU9ETt0kq/Lrr
iz+ZXl2jri8RD7V29ua88nKhXNo0tvUDxiOobZwDytf/FRItM0dbPothS0MoZkjt
ArRYHsrO+QKBgH7P4FOY3YjZOd8E06wYI4sFj3kltLADnqNo5Bz1nmt9aSQmcWxH
CNGeT2zI6bAC+3rZiMGqx3MWsXtnGotyKd54v8LE5zB61XQUljjKnDWWgCJ5T0Mq
VsB7Rc4S/66pivJKXjWZ3AgbphCR8h3gxaGMVGhC37X4ZCIovdMnSDm9AoGAA0k8
PzwSpODD2gsoStVAGYkNinjgQVGn7SP37PROMuqHV6ctdPVxXjVaO1xC1TBxDGGI
AXfJG3iGCLBjVnnvQif0hjT20QDBpzWcomEmk55xegZd4qr6azRwWGmB57NW4Xis
tb8jFEGOj/VpeVLOnzakJsemX/PYvg70zinA6ekCgYBJ9tCRZ2kNeiMKSTHRhP40
Dt4HYvQbMVqHe2LBa+0j+u9Ms4LJDkzBLrTDnuL+b8TBA98i79aUk2NfwYv4txJZ
Mur/MnsBGuGyvwVxUuEfe+bgl5rd9NNa8surDPL+IDMkFVpO8T0xGcEBQlzWDEQQ
5x7kv72ua8eKEZxvlt931g==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUTaaEwhnRU7Li3nm9keUUpud68O8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYyOTE0NDAyOVoXDTM2MDYy
NjE0NDAyOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtYTpxlgULLv9QCpvjb+xmr+vDJR2kCcqe/KYy/d2QGC+
sttzifYcleyBpEna5OFbiaU69XlmYLC2rTiJPmb1NZlkr7+Zl0ynr040nlM6mW/H
mqlwNiRH+m+Zl4LhfYoqWWvwOb3smPy0PyZjtuICo3E+ebn2tUp7bLXgOywTtxba
yH7WNTATqAp+vhY5/DU9Wt9rOQMyMWkp6pB6M1SHS8tyNSZCFqLZjsbSxBNnb9rz
Y0vg3ykuFS/kJdjnDOcL+9mqfWZY25q01aIFFiLimkEa12hz8HfPO6SuK084EBRa
MVCfnf4VPm7MlMA51d+n494r7R5yNXquBb5p6Jjs/wIDAQABo1MwUTAdBgNVHQ4E
FgQUiVlobd3MyBeAKfjZevE4UNFaetwwHwYDVR0jBBgwFoAUiVlobd3MyBeAKfjZ
evE4UNFaetwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEArGfJ
f4xsJNjRHNeeUIPi1YLOb6FAhY+TIOYFBMFKBYWXTuccRboByuXzl5mLoAxJL/h7
W+O4XmtuRlY6IwwHDnSaIMLyCj/iv5IMwcUCHe0ffDzBSI5zoPc8KfdtxnC0hNTG
N5GLA6VnuqQO4rAodamrJLBBJdzexzouCgIJDS9tPtHtUCKvSz0b6TTS9205RO59
CQkhXW6NJiNJHZB+CWp45N1kryGEpK62ny5fxtX3uir5EHuuIJvdjpIvdqNeooCI
xEOqKm1/k0A9NFbS3q+hund+dfv9ALuYcazlRIQPFdw7+UK0CvQ1n+FtPMRuitc3
mtWTGoe2pIZaTes+gA==
-----END CERTIFICATE-----`;

function tlsRoundTrip(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        rejectUnauthorized: false,
        ALPNProtocols: ['ferrings-test']
      },
      () => {
        socket.write(payload);
      }
    );

    let body = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    socket.on('end', () => resolve(body.toString('utf8')));
    socket.on('error', reject);
  });
}

function writePlainTcp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write('not tls');
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('plain TCP client was not closed by TLS server'));
    }, 3000);
    timer.unref();
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForEvent(emitter, eventName) {
  return new Promise((resolve) => {
    emitter.once(eventName, (...args) => resolve(args));
  });
}

function getConnectionCount(server) {
  return new Promise((resolve, reject) => {
    const returned = server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
    assert.equal(returned, server);
  });
}

async function waitForConnectionCount(server, expected) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const count = await getConnectionCount(server);
    if (count === expected) return count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getConnectionCount(server);
}

(async () => {
  let listeningInfo = null;
  let closeEventSeen = false;
  let secureConnectionCount = 0;
  let secureConnectionCountDuringListener = 0;
  let tlsClientErrorCount = 0;

  const server = createTlsServer(
    {
      key: TEST_KEY,
      cert: TEST_CERT,
      host: '127.0.0.1',
      port: 0,
      ALPNProtocols: ['ferrings-test'],
      handshakeTimeout: 1000,
      bufferCount: 256,
      bufferSize: 2048
    },
    (socket) => {
      secureConnectionCount += 1;
      assert.equal(socket instanceof tls.TLSSocket, true);
      assert.equal(socket.encrypted, true);
      assert.equal(socket.alpnProtocol, 'ferrings-test');
      assert.equal(server.connections().includes(socket), true);
      secureConnectionCountDuringListener = server.connections().length;
      socket.on('data', (data) => {
        socket.end(`tls:${data.toString('utf8')}`);
      });
    }
  );

  assert.equal(server instanceof IoUringTlsTransportServer, true);
  server.on('listening', (info) => {
    listeningInfo = info;
  });
  server.on('tlsClientError', (error, socket) => {
    tlsClientErrorCount += 1;
    assert.equal(error instanceof Error, true);
    assert.equal(socket instanceof tls.TLSSocket, true);
  });
  server.on('close', () => {
    closeEventSeen = true;
  });

  server.listen();
  const address = server.address();
  assert.ok(address);
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  assert.equal(typeof address.port, 'number');
  assert.equal(listeningInfo.port, address.port);
  assert.equal(server.info().backend, 'io_uring');

  try {
    const response = await tlsRoundTrip(address.port, 'ping');
    assert.equal(response, 'tls:ping');
    assert.equal(secureConnectionCount, 1);
    assert.equal(secureConnectionCountDuringListener, 1);
    assert.equal(await waitForConnectionCount(server, 0), 0);

    const [[plainError]] = await Promise.all([
      waitForEvent(server, 'tlsClientError'),
      writePlainTcp(address.port)
    ]);
    assert.equal(plainError instanceof Error, true);
    assert.equal(tlsClientErrorCount, 1);
    assert.equal(secureConnectionCount, 1);
  } finally {
    server.close();
  }

  assert.equal(closeEventSeen, true);
  assert.equal(server.address(), null);
  assert.deepEqual(server.connections(), []);
})();
