'use strict';

const assert = require('node:assert/strict');
const {
  runQueueStatsParserSelfTest,
  runZcrxHardwareSmoke
} = require('../zcrx-smoke');

(async () => {
  try {
    if (process.argv.includes('--self-test')) {
      runQueueStatsParserSelfTest();
      await assert.rejects(
        () => runZcrxHardwareSmoke({ rxQueue: -1 }),
        /rxQueue must be an integer between 0 and 4294967295/
      );
      await assert.rejects(
        () => runZcrxHardwareSmoke({ rxBufferSize: 1.5 }),
        /rxBufferSize must be an integer between 0 and 4294967295/
      );
      await assert.rejects(
        () => runZcrxHardwareSmoke({ timeoutMs: 0 }),
        /timeoutMs must be an integer between 1 and 2147483647/
      );
      console.log('zcrx queue stats parser self-test ok');
      return;
    }

    const report = await runZcrxHardwareSmoke();
    if (report.status === 'skipped') {
      console.log(`zcrx hardware smoke skipped: ${report.skippedReason}`);
      return;
    }
    for (const warning of report.warnings || []) {
      console.warn(`zcrx hardware smoke warning: ${warning}`);
    }
    if (report.queueCounters && report.queueCounters.positiveDeltas.length > 0) {
      console.log(
        `zcrx selected RX queue ${report.config.rxQueue} counter evidence: ` +
          report.queueCounters.positiveDeltas
            .map(({ name, delta }) => `${name}+${delta}`)
            .join(', ')
      );
    }
    console.log('zcrx hardware smoke ok');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
