const ROUTE_TABLE_START = 10000;
const ROUTE_PRIORITY_START = 20000;
const NAMESPACE_BASE = (10 << 24) + (64 << 16);
const NAMESPACE_SLOTS = (64 * 256 * 256) / 4;

function nextUnused(start, used, label) {
  let value = Math.max(1, Number(start) || 1);
  while (used.has(value)) value += 1;
  if (value > 0xffffffff) throw new Error(`${label} 已耗尽`);
  return value;
}

function ipv4FromInteger(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

export function namespaceNetwork(index) {
  const slot = Number(index);
  if (!Number.isInteger(slot) || slot < 0 || slot >= NAMESPACE_SLOTS) {
    throw new Error('L2TP 隔离网段资源已耗尽');
  }
  const token = slot.toString(36);
  const network = NAMESPACE_BASE + slot * 4;
  return {
    namespaceIndex: slot,
    namespace: `sk5-l2tp-${token}`,
    hostVeth: `sk5h${token}`.slice(0, 15),
    namespaceVeth: `sk5n${token}`.slice(0, 15),
    hostIp: ipv4FromInteger(network + 1),
    namespaceIp: ipv4FromInteger(network + 2),
    cidr: 30
  };
}

export function ensureResourceAllocations(state) {
  let changed = false;
  state.allocations ||= {};

  const usedTables = new Set();
  const usedPriorities = new Set();
  for (const proxy of state.proxies || []) {
    if (Number.isInteger(proxy.routeTable) && !usedTables.has(proxy.routeTable)) usedTables.add(proxy.routeTable);
    else if (proxy.routeTable !== undefined) { delete proxy.routeTable; changed = true; }
    if (Number.isInteger(proxy.routePriority) && !usedPriorities.has(proxy.routePriority)) usedPriorities.add(proxy.routePriority);
    else if (proxy.routePriority !== undefined) { delete proxy.routePriority; changed = true; }
  }

  let nextTable = nextUnused(state.allocations.nextRouteTable || ROUTE_TABLE_START, usedTables, '策略路由表');
  let nextPriority = nextUnused(state.allocations.nextRoutePriority || ROUTE_PRIORITY_START, usedPriorities, '策略路由优先级');
  for (const proxy of state.proxies || []) {
    if (!Number.isInteger(proxy.routeTable)) {
      proxy.routeTable = nextTable;
      usedTables.add(nextTable);
      nextTable = nextUnused(nextTable + 1, usedTables, '策略路由表');
      changed = true;
    }
    if (!Number.isInteger(proxy.routePriority)) {
      proxy.routePriority = nextPriority;
      usedPriorities.add(nextPriority);
      nextPriority = nextUnused(nextPriority + 1, usedPriorities, '策略路由优先级');
      changed = true;
    }
  }

  const usedNamespaceIndexes = new Set();
  for (const connection of state.l2tp || []) {
    if (Number.isInteger(connection.namespaceIndex) && !usedNamespaceIndexes.has(connection.namespaceIndex)) {
      usedNamespaceIndexes.add(connection.namespaceIndex);
    } else if (connection.namespaceIndex !== undefined) {
      delete connection.namespaceIndex;
      changed = true;
    }
  }
  let nextNamespaceIndex = Math.max(0, Number(state.allocations.nextNamespaceIndex) || 0);
  while (usedNamespaceIndexes.has(nextNamespaceIndex)) nextNamespaceIndex += 1;
  for (const connection of state.l2tp || []) {
    if (!Number.isInteger(connection.namespaceIndex)) {
      Object.assign(connection, namespaceNetwork(nextNamespaceIndex));
      usedNamespaceIndexes.add(nextNamespaceIndex);
      nextNamespaceIndex += 1;
      while (usedNamespaceIndexes.has(nextNamespaceIndex)) nextNamespaceIndex += 1;
      changed = true;
    }
  }

  const next = {
    nextRouteTable: nextUnused(nextTable, usedTables, '策略路由表'),
    nextRoutePriority: nextUnused(nextPriority, usedPriorities, '策略路由优先级'),
    nextNamespaceIndex
  };
  if (JSON.stringify(state.allocations) !== JSON.stringify(next)) {
    state.allocations = next;
    changed = true;
  }
  return changed;
}

export function allocateProxyRouting(state) {
  ensureResourceAllocations(state);
  const usedTables = new Set(state.proxies.map((proxy) => proxy.routeTable).filter(Number.isInteger));
  const usedPriorities = new Set(state.proxies.map((proxy) => proxy.routePriority).filter(Number.isInteger));
  const routeTable = nextUnused(state.allocations.nextRouteTable, usedTables, '策略路由表');
  const routePriority = nextUnused(state.allocations.nextRoutePriority, usedPriorities, '策略路由优先级');
  state.allocations.nextRouteTable = nextUnused(routeTable + 1, usedTables, '策略路由表');
  state.allocations.nextRoutePriority = nextUnused(routePriority + 1, usedPriorities, '策略路由优先级');
  return { routeTable, routePriority };
}

export function allocateL2tpNetwork(state) {
  ensureResourceAllocations(state);
  const used = new Set(state.l2tp.map((connection) => connection.namespaceIndex).filter(Number.isInteger));
  let index = state.allocations.nextNamespaceIndex;
  while (used.has(index)) index += 1;
  const network = namespaceNetwork(index);
  state.allocations.nextNamespaceIndex = index + 1;
  return network;
}
