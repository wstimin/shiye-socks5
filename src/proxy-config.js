export function render3ProxyConfig(proxy, password) {
  const allowlist = proxy.allowlist?.length
    ? proxy.allowlist.map((cidr) => `allow ${proxy.username} ${cidr}`).join('\n')
    : `allow ${proxy.username}`;
  const bytesPerSecond = Math.max(1, Number(proxy.bandwidthMbps) || 100) * 125000;
  return [
    `maxconn ${Math.max(1, Number(proxy.maxConnections) || 500)}`,
    'nscache 65536',
    'timeouts 1 5 30 60 180 1800 15 60',
    'auth strong',
    `users ${proxy.username}:CL:${password}`,
    allowlist,
    `bandlimin ${bytesPerSecond} ${proxy.username}`,
    `bandlimout ${bytesPerSecond} ${proxy.username}`,
    `internal ${proxy.outboundType === 'l2tp' ? '0.0.0.0' : proxy.listenIp}`,
    proxy.outboundType === 'public-ip' ? `external ${proxy.expectedIp}` : '',
    `socks -p${proxy.port}`,
    'flush',
    'deny *'
  ].filter(Boolean).join('\n') + '\n';
}

export function renderInstanceManifest(proxy) {
  return JSON.stringify({
    id: proxy.id,
    namespace: `sk5-${proxy.id}`,
    listen: { ip: proxy.listenIp, port: proxy.port },
    outbound: { type: proxy.outboundType, id: proxy.outboundId, expectedIp: proxy.expectedIp },
    failClosed: true
  }, null, 2) + '\n';
}
