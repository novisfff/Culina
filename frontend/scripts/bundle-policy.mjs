// v2 budgets measure explicit asset sets, not the size of a single entry chunk.
// Legacy phase/rollout and historical health baselines do not participate.
function bytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}: expected non-negative integer bytes`);
  return value;
}

function validateManifest(manifest, label) {
  if (manifest?.version !== 1 || !manifest.entries?.main || !manifest.assets
    || !Array.isArray(manifest.manifestErrors) || manifest.manifestErrors.length) {
    throw new Error(`${label}: incomplete or invalid bundle manifest`);
  }
  for (const [id, entry] of Object.entries(manifest.entries)) {
    for (const key of ['initial', 'routeTotal']) {
      if (!Array.isArray(entry[key]?.assets) || entry[key].assets.length === 0) throw new Error(`${label}: ${id}.${key} assets missing`);
      for (const asset of entry[key].assets) {
        if (!manifest.assets[asset]) throw new Error(`${label}: unresolved asset ${asset}`);
      }
    }
  }
  for (const [asset, data] of Object.entries(manifest.assets)) bytes(data.gzipBytes, `${label}:${asset}`);
}

function validatePolicy(policy) {
  if (policy?.version !== 2 || !policy.profiles || !policy.entries || !policy.growth) {
    throw new Error('bundle policy must contain version 2, profiles, entries and growth');
  }
  for (const [name, profile] of Object.entries(policy.profiles)) {
    if (!['startup', 'route', 'aggregate'].includes(profile.kind)) throw new Error(`invalid profile kind: ${name}`);
    for (const metric of ['js', 'css']) {
      const limits = profile[metric];
      bytes(limits?.warn, `${name}.${metric}.warn`);
      bytes(limits?.fail, `${name}.${metric}.fail`);
      if (limits.warn >= limits.fail) throw new Error(`warning must precede limit: ${name}.${metric}`);
    }
  }
  for (const [id, entry] of Object.entries(policy.entries)) {
    if (!policy.profiles[entry.profile] || !entry.owner) throw new Error(`invalid policy entry: ${id}`);
  }
  for (const name of ['startupJs', 'routeJs', 'css', 'aggregateJs', 'aggregateCss']) {
    const growth = policy.growth[name];
    for (const level of ['warn', 'fail']) {
      bytes(growth?.[level]?.bytes, `${name}.${level}.bytes`);
      const ratio = growth?.[level]?.ratio;
      if (!Number.isFinite(ratio) || ratio < 0) throw new Error(`invalid ratio: ${name}.${level}`);
    }
    if (growth.warn.bytes > growth.fail.bytes || growth.warn.ratio > growth.fail.ratio) {
      throw new Error(`warning must precede growth limit: ${name}`);
    }
  }
}

function sumAssets(manifest, assets) {
  const values = { js: 0, css: 0 };
  for (const asset of new Set(assets)) {
    if (!asset.endsWith('.js') && !asset.endsWith('.css')) continue;
    const key = asset.endsWith('.css') ? 'css' : 'js';
    values[key] += bytes(manifest.assets[asset]?.gzipBytes, asset);
  }
  return values;
}

export function measureBundlePolicy(manifest, policy) {
  validateManifest(manifest, 'manifest');
  const startup = new Set(manifest.entries.main.initial.assets);
  const result = {};
  for (const [id, budget] of Object.entries(policy.entries)) {
    const entry = manifest.entries[id];
    if (!entry) continue;
    const kind = policy.profiles[budget.profile].kind;
    // Route totals are conservative: descendants may include optional lazy dialogs.
    // Only startup assets are deducted; shared-but-not-yet-loaded dependencies still count.
    const assets = kind === 'startup' ? [...startup]
      : kind === 'aggregate' ? entry.routeTotal.assets
        : entry.routeTotal.assets.filter((asset) => !startup.has(asset));
    result[id] = { ...sumAssets(manifest, assets), assets: [...new Set(assets)].sort(), kind };
  }
  result['all-assets'] = { ...sumAssets(manifest, Object.keys(manifest.assets)), assets: Object.keys(manifest.assets).sort(), kind: 'aggregate' };
  return result;
}

function kib(value) { return `${(value / 1024).toFixed(1)} KiB`; }

export function evaluateBundlePolicy({ manifest, baseManifest, policy, requireBase = false, expectedBaseCommit }) {
  validatePolicy(policy);
  validateManifest(manifest, 'current');
  if (requireBase && !baseManifest) throw new Error('target-branch manifest required; incremental check cannot be skipped');
  if (baseManifest) {
    validateManifest(baseManifest, 'base');
    if (expectedBaseCommit && baseManifest.sourceCommit !== expectedBaseCommit) {
      throw new Error(`base manifest commit mismatch: expected ${expectedBaseCommit}, got ${baseManifest.sourceCommit}`);
    }
  }
  const current = measureBundlePolicy(manifest, policy);
  const base = baseManifest ? measureBundlePolicy(baseManifest, policy) : {};
  const rows = [];
  const warnings = [];
  const violations = [];
  for (const id of Object.keys(manifest.entries)) {
    if (!policy.entries[id]) violations.push({ entry: id, reason: 'unbudgeted logical entry' });
  }
  for (const id of Object.keys(policy.entries)) {
    if (!current[id]) violations.push({ entry: id, reason: 'configured entry missing from manifest' });
  }
  for (const [id, values] of Object.entries(current)) {
    const profile = id === 'all-assets' ? policy.total : policy.profiles[policy.entries[id].profile];
    for (const metric of ['js', 'css']) {
      const limit = profile?.[metric];
      bytes(limit?.warn, `${id}.${metric}.warn`);
      bytes(limit?.fail, `${id}.${metric}.fail`);
      if (limit.warn >= limit.fail) throw new Error(`warning must precede limit: ${id}.${metric}`);
      const previous = base[id]?.[metric];
      const delta = previous === undefined ? null : values[metric] - previous;
      const growthKey = values.kind === 'aggregate' ? (metric === 'js' ? 'aggregateJs' : 'aggregateCss')
        : metric === 'css' ? 'css' : values.kind === 'startup' ? 'startupJs' : 'routeJs';
      const growth = policy.growth[growthKey];
      const allowedGrowth = previous === undefined ? null : Math.max(growth.fail.bytes, Math.ceil(previous * growth.fail.ratio));
      const warningGrowth = previous === undefined ? null : Math.max(growth.warn.bytes, Math.ceil(previous * growth.warn.ratio));
      const reasons = [];
      let status = 'pass';
      if (values[metric] > limit.fail) { status = 'fail'; reasons.push('absolute budget exceeded'); }
      else if (values[metric] > limit.warn) { status = 'warning'; reasons.push('approaching absolute budget'); }
      if (delta !== null && delta > allowedGrowth) { status = 'fail'; reasons.push('PR growth exceeded'); }
      else if (delta !== null && delta > warningGrowth) { if (status !== 'fail') status = 'warning'; reasons.push('PR growth warning'); }
      if (baseManifest && previous === undefined) {
        if (status !== 'fail') status = 'warning';
        reasons.push('new entry: absolute budget applied, no comparable base');
      }
      const row = { entry: id, metric, kind: values.kind, current: values[metric], baseline: previous ?? null,
        delta, allowed: limit.fail, warning: limit.warn, allowedGrowth, headroom: limit.fail - values[metric], status, reason: reasons.join('; ') };
      rows.push(row);
      if (status === 'fail') violations.push(row);
      else if (status === 'warning') warnings.push(row);
    }
  }
  // Report the largest changes by stable source-module identity instead of hashed filenames.
  const identity = (asset, data) => `${asset.endsWith('.css') ? 'css' : 'js'}:${[...(data.sourceModules ?? [])].sort().join('|') || asset.replace(/-[\w-]{8,}(?=\.)/, '')}`;
  const oldAssets = new Map();
  for (const [asset, data] of Object.entries(baseManifest?.assets ?? {})) {
    const key = identity(asset, data);
    oldAssets.set(key, (oldAssets.get(key) ?? 0) + data.gzipBytes);
  }
  const contributors = Object.entries(manifest.assets).map(([asset, data]) => ({
    asset, current: data.gzipBytes, delta: data.gzipBytes - (oldAssets.get(identity(asset, data)) ?? 0),
  })).filter((item) => item.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 8);
  const lines = [
    '## Frontend bundle budgets',
    '',
    `Comparison: ${baseManifest ? `target commit ${baseManifest.sourceCommit}` : 'absolute budgets only (no base supplied)'}. All sizes are gzip.`,
    'JS/CSS totals conservatively include lazy descendants and deduct only assets already in startup. Shared dependencies are not assumed cached; images remain under the public-asset guard.',
    '',
    '| Entry | Metric | Base | Current | Change | Hard limit | Headroom | Result |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows.map((row) => `| ${row.entry} | ${row.metric} | ${row.baseline === null ? '—' : kib(row.baseline)} | ${kib(row.current)} | ${row.delta === null ? '—' : kib(row.delta)} | ${kib(row.allowed)} | ${kib(row.headroom)} | ${row.status}${row.reason ? `: ${row.reason}` : ''} |`),
    '',
    ...violations.filter((row) => !row.metric).map((row) => `- FAIL ${row.entry}: ${row.reason}`),
    ...(baseManifest ? ['', 'Largest changed assets (chunk regrouping can appear as new assets):', ...contributors.map((item) => `- ${item.asset}: +${kib(item.delta)}`)] : []),
  ];
  return { mode: 'policy', rows, warnings, violations, manifestErrors: [], contributors,
    comparison: { baseCommit: baseManifest?.sourceCommit ?? null, currentCommit: manifest.sourceCommit ?? null },
    summary: `${lines.join('\n')}\n`, exitCode: violations.length ? 1 : 0 };
}
