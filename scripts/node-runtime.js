'use strict';

function runtimeSupport(packageJson, nodeVersion = process.versions.node) {
  const engineRange = packageJson.engines?.node;
  const supportedMajors = supportedNodeMajors(engineRange);
  const currentMajor = nodeMajor(nodeVersion);
  const ok = supportedMajors.length === 0 || supportedMajors.includes(currentMajor);
  return {
    ok,
    engineRange: engineRange || null,
    currentVersion: nodeVersion,
    currentMajor,
    supportedMajors,
    detail: ok
      ? `Node.js ${nodeVersion} is supported`
      : unsupportedRuntimeMessage(engineRange, nodeVersion, supportedMajors)
  };
}

function unsupportedRuntimeMessage(engineRange, nodeVersion, supportedMajors) {
  const supported = supportedMajors.length > 0
    ? supportedMajors.join(', ')
    : 'the package.json engines range';
  const current = nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`;
  return (
    `Node.js ${current} is not supported by engines ${engineRange || '(missing)'}; ` +
    `use Node.js ${supported}.`
  );
}

function supportedNodeMajors(engineRange) {
  if (typeof engineRange !== 'string') return [];
  const majors = [];
  for (const match of engineRange.matchAll(/>=\s*(\d+)\s*<\s*(\d+)/g)) {
    const min = Number.parseInt(match[1], 10);
    const max = Number.parseInt(match[2], 10);
    if (Number.isInteger(min) && max === min + 1) {
      majors.push(min);
    }
  }
  return [...new Set(majors)];
}

function nodeMajor(nodeVersion) {
  const major = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10);
  return Number.isInteger(major) ? major : NaN;
}

module.exports = {
  nodeMajor,
  runtimeSupport,
  supportedNodeMajors
};
