'use strict';

const {
  runQueueStatsParserSelfTest,
  runZcrxHardwareSmoke
} = require('../zcrx-smoke');

(async () => {
  try {
    if (process.argv.includes('--self-test')) {
      runQueueStatsParserSelfTest();
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
