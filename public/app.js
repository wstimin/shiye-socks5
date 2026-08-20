const state = {
  data: null,
  auth: null,
  view: 'overview',
  modal: null,
  revealed: new Map(),
  pages: { proxies: 1, ips: 1 },
  pageSize: 10
};

const viewMeta = {
  overview: ['运行总览', '查看代理出口校验与网络状态'],
  proxies: ['SOCKS5 实例', '管理入口、认证凭据与专属公网出口'],
  'public-ips': ['服务器公网 IP', '自动检测本机所有网卡上的公网地址，不限制数量'],
  l2tp: ['L2TP 连接', '管理拨号线路、PPP 接口与动态出口'],
  interfaces: ['网络接口', '自动识别网卡、内网 IP 与默认路由'],
  logs: ['事件日志', '追踪线路、代理、审计与系统事件'],
  settings: ['系统设置', '配置健康检查、故障策略与访问控制']
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const formatTraffic = (mb) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
};
const formatTime = (date) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));

function icons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.auth?.csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET') ? { 'X-CSRF-Token': state.auth.csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.replace('/login.html');
    throw new Error('登录已失效，请重新登录');
  }
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}

async function refresh() {
  state.data = await api('/api/bootstrap');
  renderAll();
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = `<i data-lucide="${type === 'error' ? 'circle-alert' : 'circle-check'}"></i><span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(item);
  icons();
  setTimeout(() => item.remove(), 3600);
}

function statusText(status) {
  return ({ online: '运行中', available: '可分配', assigned: '已分配', checking: '校验中', stopped: '已停止', mismatch: '出口异常', error: '异常' })[status] || status;
}

function renderAll() {
  const { overview, system } = state.data;
  $('#nav-proxy-count').textContent = overview.totalProxies;
  $('#nav-ip-count').textContent = overview.publicIpCount;
  $('#nav-l2tp-count').textContent = overview.totalL2tp;
  $('#mode-label').textContent = system.modeLabel;
  $('#side-mode').textContent = system.modeLabel;
  $('#admin-name').textContent = system.adminUser || state.auth?.username || 'admin';
  renderReadiness();
  renderOverview();
  renderProxies();
  renderIps();
  renderL2tp();
  renderInterfaces();
  renderLogs();
  renderSettings();
  icons();
}

function productionReady() {
  return state.data?.system?.ready === true;
}

function disabledWhenReadonly() {
  return productionReady() ? '' : 'disabled';
}

function renderReadiness() {
  const { readiness } = state.data.system;
  const banner = $('#readiness-banner');
  banner.classList.toggle('ready', readiness.ready);
  const failed = readiness.checks.filter((item) => !item.ok);
  banner.innerHTML = `<div class="readiness-main"><i data-lucide="${readiness.ready ? 'badge-check' : 'lock-keyhole'}"></i><div><strong>${escapeHtml(readiness.ready ? 'Linux 生产执行环境已就绪' : '当前为只读模式')}</strong><span>${escapeHtml(readiness.message)}</span></div></div>${failed.length ? `<details><summary>查看 ${failed.length} 项未通过检查</summary><div class="readiness-checks">${failed.map((item) => `<span><b>${escapeHtml(item.label)}</b>${escapeHtml(item.detail)}</span>`).join('')}</div></details>` : ''}`;
  $('#header-create').disabled = !readiness.ready;
  $$('[data-open="proxy"], [data-open="l2tp"], #check-all-proxies').forEach((button) => { button.disabled = !readiness.ready; });
  $$('#settings-form input, #settings-form textarea, #settings-form button').forEach((control) => { control.disabled = !readiness.ready; });
  $('.status-pulse').classList.toggle('readonly', !readiness.ready);
}

function renderOverview() {
  const { overview, proxies, publicIps, logs, l2tp } = state.data;
  const kpis = [
    { label: '在线代理', value: `${overview.onlineProxies}/${overview.totalProxies}`, icon: 'shield-check', color: '#6366F1', gradient: 'linear-gradient(135deg,#6366F1,#06B6D4)', foot: '已通过出口校验', delta: `${overview.onlineProxies} 正常` },
    { label: '公网 IP 资源', value: overview.publicIpCount, icon: 'globe-2', color: '#06B6D4', gradient: 'linear-gradient(135deg,#06B6D4,#22D3EE)', foot: '地址池不设数量上限', delta: `${overview.availableIpCount} 可用` },
    { label: '连接统计', value: '--', icon: 'radio-tower', color: '#A855F7', gradient: 'linear-gradient(135deg,#A855F7,#EC4899)', foot: '尚未接入会话采集', delta: '未采集' },
    { label: '流量统计', value: '--', icon: 'chart-no-axes-combined', color: '#EC4899', gradient: 'linear-gradient(135deg,#EC4899,#F59E0B)', foot: '尚未接入实例计量', delta: '未采集' }
  ];
  $('#kpi-grid').innerHTML = kpis.map((item) => `<article class="kpi-card" style="--kpi-color:${item.color};--kpi-gradient:${item.gradient}"><div class="kpi-top"><span>${item.label}</span><div class="kpi-icon"><i data-lucide="${item.icon}"></i></div></div><div class="kpi-value">${item.value}</div><div class="kpi-foot"><span>${item.foot}</span><strong class="kpi-delta">${item.delta}</strong></div></article>`).join('');
  renderChart();
  const hasHealthData = overview.totalProxies > 0 || publicIps.length > 0 || l2tp.length > 0;
  const health = [
    ['代理可用率', overview.totalProxies ? Math.round(overview.onlineProxies / overview.totalProxies * 100) : null],
    ['公网 IP 已检测率', publicIps.length ? Math.round(publicIps.filter((item) => item.measuredIp).length / publicIps.length * 100) : null],
    ['L2TP 在线率', l2tp.length ? Math.round(l2tp.filter((item) => item.status === 'online').length / l2tp.length * 100) : null]
  ];
  const measuredHealth = health.filter(([, value]) => value !== null).map(([, value]) => value);
  const healthScore = measuredHealth.length ? Math.round(measuredHealth.reduce((sum, value) => sum + value, 0) / measuredHealth.length) : null;
  $('#health-score').textContent = healthScore ?? '--';
  $('#health-state').textContent = hasHealthData ? '基于真实状态' : '等待真实数据';
  $('#health-state').className = `status-badge ${hasHealthData ? 'assigned' : 'warning'}`;
  $('#health-list').innerHTML = health.map(([label, value]) => `<div class="health-item"><span>${label}</span><strong>${value === null ? '--' : value + '%'}</strong><div><i style="width:${value || 0}%"></i></div></div>`).join('');
  $('#overview-proxies').innerHTML = proxies.length ? proxies.slice(0, 3).map(proxyCard).join('') : empty('暂无真实代理实例', productionReady() ? '创建第一个 SOCKS5 实例开始使用' : 'Linux 生产执行环境就绪后才可创建');
  $('#overview-ips').innerHTML = publicIps.slice(0, 4).map((item) => `<div class="compact-row"><strong>${escapeHtml(item.address)}</strong><span>${escapeHtml(item.interface)}</span><em class="status-badge ${item.status}">${statusText(item.status)}</em></div>`).join('') || empty('暂无公网 IP', '点击检测服务器 IP 自动识别网卡地址');
  $('#overview-logs').innerHTML = logs.slice(0, 4).map((item) => `<div class="compact-row"><strong>${formatTime(item.createdAt)}</strong><span>${escapeHtml(item.message)}</span><em class="status-badge ${item.level}">${item.scope}</em></div>`).join('');
}

function renderChart() {
  $('#traffic-chart').innerHTML = empty('暂无真实运行数据', '接入实例指标采集后显示 24 小时流量趋势');
}

function proxyCard(proxy) {
  return `<article class="glass-card proxy-mini"><div class="proxy-mini-head"><div class="proxy-mini-name"><div class="proxy-node-icon"><i data-lucide="shield-check"></i></div><div><h3>${escapeHtml(proxy.name)}</h3><p>${escapeHtml(proxy.username)} · 会话指标未采集</p></div></div><span class="status-badge ${proxy.status}">${statusText(proxy.status)}</span></div><div class="proxy-route"><div class="route-endpoint"><span>入口</span><strong>${escapeHtml(proxy.listenIp)}:${proxy.port}</strong></div><div class="route-arrow"><i data-lucide="arrow-right"></i></div><div class="route-endpoint"><span>专属出口</span><strong>${escapeHtml(proxy.actualIp || proxy.expectedIp)}</strong></div></div><div class="proxy-stats"><span>流量 <strong>未采集</strong></span><span>连接 <strong>未采集</strong></span><span>上限 <strong>${proxy.bandwidthMbps} Mbps</strong></span></div></article>`;
}

function filteredProxies() {
  const query = ($('#proxy-search')?.value || '').trim().toLowerCase();
  const status = $('#proxy-status-filter')?.value || 'all';
  return state.data.proxies.filter((item) => {
    const matches = [item.name, item.listenIp, item.port, item.username, item.outboundLabel].join(' ').toLowerCase().includes(query);
    return matches && (status === 'all' || item.status === status);
  });
}

function renderProxies() {
  const items = filteredProxies();
  const paged = paginate(items, state.pages.proxies);
  $('#proxy-table').innerHTML = paged.items.map((proxy) => {
    const credential = state.revealed.get(`proxy:${proxy.id}`);
    const password = credential?.password || '••••••••••••';
    return `<tr><td><div class="cell-title"><div class="cell-orb"><i data-lucide="shield"></i></div><div><strong>${escapeHtml(proxy.name)}</strong><span>${escapeHtml(proxy.id)}</span></div></div></td><td><div class="cell-stack"><strong class="mono">${escapeHtml(proxy.listenIp)}:${proxy.port}</strong><span>最大 ${formatNumber(proxy.maxConnections)} 连接</span></div></td><td><div class="cell-stack"><strong class="mono">${escapeHtml(proxy.username)}</strong><span class="credential-row"><b class="credential-value">${escapeHtml(password)}</b><button class="mini-action" data-reveal-proxy="${proxy.id}" title="${credential ? '隐藏密码' : '查看密码'}"><i data-lucide="${credential ? 'eye-off' : 'eye'}"></i></button><button class="mini-action" data-copy-credential="${proxy.id}" title="复制连接信息"><i data-lucide="copy"></i></button></span></div></td><td><div class="cell-stack"><strong class="mono">${escapeHtml(proxy.actualIp || '尚未实测')}</strong><span>${proxy.outboundType === 'l2tp' ? 'L2TP · ' : '公网 IP · '}${escapeHtml(proxy.outboundLabel)}</span></div></td><td><span class="status-badge ${proxy.status}">${statusText(proxy.status)}</span><div class="cell-stack"><span>${proxy.lastCheckedAt ? formatTime(proxy.lastCheckedAt) + ' 校验' : '尚未校验'}</span></div></td><td><div class="cell-stack"><strong>未接入采集</strong><span>不展示估算值</span></div></td><td class="right"><div class="row-actions"><button class="mini-action" data-proxy-action="check" data-id="${proxy.id}" title="校验出口" ${disabledWhenReadonly()}><i data-lucide="activity"></i></button><button class="mini-action" data-proxy-action="${proxy.status === 'stopped' ? 'start' : 'stop'}" data-id="${proxy.id}" title="${proxy.status === 'stopped' ? '启动' : '停止'}" ${disabledWhenReadonly()}><i data-lucide="${proxy.status === 'stopped' ? 'play' : 'square'}"></i></button><button class="mini-action" data-proxy-action="restart" data-id="${proxy.id}" title="重启" ${disabledWhenReadonly()}><i data-lucide="rotate-cw"></i></button><button class="mini-action danger" data-delete-proxy="${proxy.id}" title="删除" ${disabledWhenReadonly()}><i data-lucide="trash-2"></i></button></div></td></tr>`;
  }).join('') || `<tr><td colspan="7">${empty('没有匹配的代理实例', '调整筛选条件或创建新实例')}</td></tr>`;
  $('#proxy-footer').innerHTML = footer(items.length, paged.page, paged.pages, 'proxy');
  icons();
}

function filteredIps() {
  const query = ($('#ip-search')?.value || '').trim().toLowerCase();
  const status = $('#ip-status-filter')?.value || 'all';
  return state.data.publicIps.filter((item) => {
    const proxy = state.data.proxies.find((entry) => entry.id === item.assignedTo);
    const matches = [item.address, item.interface, item.gateway, item.provider, proxy?.name].join(' ').toLowerCase().includes(query);
    return matches && (status === 'all' || item.status === status);
  });
}

function renderIps() {
  const total = state.data.publicIps.length;
  const available = state.data.publicIps.filter((item) => item.status === 'available').length;
  const assigned = state.data.publicIps.filter((item) => item.assignedTo).length;
  const online = state.data.publicIps.filter((item) => item.measuredIp).length;
  $('#ip-summary').innerHTML = [['地址池总量', total], ['可分配', available], ['已专属分配', assigned], ['已完成出口检测', online]].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${formatNumber(value)}</strong></div>`).join('');
  const items = filteredIps();
  const paged = paginate(items, state.pages.ips);
  $('#ip-table').innerHTML = paged.items.map((item) => {
    const proxy = state.data.proxies.find((entry) => entry.id === item.assignedTo);
    return `<tr><td><div class="cell-title"><div class="cell-orb"><i data-lucide="globe-2"></i></div><div><strong class="mono">${escapeHtml(item.address)}</strong><span>${escapeHtml(item.id)}</span></div></div></td><td><div class="cell-stack"><strong>${escapeHtml(item.interface)}</strong><span class="mono">${escapeHtml(item.gateway || '自动路由')}</span></div></td><td>${escapeHtml(item.provider)}</td><td><div class="cell-stack"><strong class="mono">${escapeHtml(item.measuredIp || '未检测')}</strong><span>${item.measuredIp === item.address ? '出口一致' : item.measuredIp ? '需要复核' : '等待 SOCKS5 校验'}</span></div></td><td>${proxy ? `<div class="cell-stack"><span class="status-badge assigned">已分配</span><span>${escapeHtml(proxy.name)}</span></div>` : '<span class="status-badge available">可分配</span>'}</td><td class="right"><div class="row-actions">${proxy ? `<button class="mini-action" data-go-proxy="${proxy.id}" title="查看实例"><i data-lucide="external-link"></i></button>` : `<button class="mini-action" data-create-with-ip="${item.id}" title="使用此 IP 创建 SOCKS5" ${disabledWhenReadonly()}><i data-lucide="plus"></i></button>`}</div></td></tr>`;
  }).join('') || `<tr><td colspan="6">${empty('未检测到服务器公网 IP', '点击“检测服务器 IP”读取全部网卡地址')}</td></tr>`;
  $('#ip-footer').innerHTML = footer(items.length, paged.page, paged.pages, 'ip');
  icons();
}

function renderL2tp() {
  $('#l2tp-grid').innerHTML = state.data.l2tp.length ? state.data.l2tp.map((item) => {
    const secret = state.revealed.get(`l2tp:${item.id}`);
    return `<article class="l2tp-card"><div class="l2tp-head"><div class="l2tp-title"><div class="cell-orb"><i data-lucide="waypoints"></i></div><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.server)}</p></div></div><span class="status-badge ${item.status}">${statusText(item.status)}</span></div><div class="detail-grid"><div><span>PPP 接口</span><strong class="mono">${escapeHtml(item.interface || '未建立')}</strong></div><div><span>实际出口</span><strong class="mono">${escapeHtml(item.actualIp || '尚未实测')}</strong></div><div><span>认证用户</span><strong>${escapeHtml(item.username)}</strong></div><div><span>密码</span><strong class="credential-row"><b class="credential-value">${escapeHtml(secret?.password || '••••••••••')}</b><button class="mini-action" data-reveal-l2tp="${item.id}" title="查看密码"><i data-lucide="${secret ? 'eye-off' : 'eye'}"></i></button><button class="mini-action" data-copy-l2tp="${item.id}" title="复制凭据"><i data-lucide="copy"></i></button></strong></div><div><span>IPsec</span><strong>${item.ipsec ? '已启用 PSK' : '未启用'}</strong></div><div><span>手动重拨次数</span><strong>${item.reconnects} 次</strong></div></div><div class="l2tp-actions"><span>MTU ${item.mtu}</span><div class="row-actions"><button class="mini-action" data-l2tp-action="${item.status === 'online' ? 'disconnect' : 'connect'}" data-id="${item.id}" title="${item.status === 'online' ? '断开' : '连接'}" ${disabledWhenReadonly()}><i data-lucide="${item.status === 'online' ? 'unplug' : 'plug-zap'}"></i></button><button class="mini-action" data-l2tp-action="reconnect" data-id="${item.id}" title="重拨" ${disabledWhenReadonly()}><i data-lucide="rotate-cw"></i></button><button class="mini-action danger" data-delete-l2tp="${item.id}" title="删除" ${disabledWhenReadonly()}><i data-lucide="trash-2"></i></button></div></div></article>`;
  }).join('') : empty('暂无 L2TP 连接', '添加线路后可作为 SOCKS5 专属出口');
  icons();
}

function renderInterfaces() {
  const network = state.data.system.network;
  const nativeMetrics = network.source === 'native';
  $('#interface-grid').innerHTML = network.interfaces.length ? network.interfaces.map((item) => `<article class="interface-card"><div class="interface-head"><div class="interface-title"><div class="cell-orb"><i data-lucide="${item.kind === 'ppp' ? 'waypoints' : item.kind === 'loopback' ? 'repeat-2' : 'ethernet-port'}"></i></div><div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.kind)} · ${escapeHtml(item.mac)}</p></div></div><span class="status-badge ${item.state === 'up' ? 'online' : 'stopped'}">${item.state === 'up' ? 'UP' : 'DOWN'}</span></div><div class="address-list">${item.addresses.map((address) => `<div class="address-item"><code>${escapeHtml(address.cidr)}</code><span class="status-badge ${address.type === 'private' ? 'assigned' : address.type === 'public' ? 'available' : 'warning'}">${address.type}</span></div>`).join('') || '<div class="address-item"><span>无 IPv4 地址</span></div>'}</div><div class="traffic-meter"><div><span>接收流量</span><strong>${nativeMetrics ? formatBytes(item.rxBytes) : '未采集'}</strong></div><div><span>发送流量</span><strong>${nativeMetrics ? formatBytes(item.txBytes) : '未采集'}</strong></div></div><div class="l2tp-actions"><span>MTU ${item.mtu || '-'}</span>${item.defaultRoute ? '<span class="status-badge assigned">默认路由</span>' : '<span>非默认出口</span>'}</div></article>`).join('') : empty('未识别到网络接口', '请检查系统权限和网络配置');
  icons();
}

function renderLogs() {
  const query = ($('#log-search')?.value || '').trim().toLowerCase();
  const level = $('#log-level-filter')?.value || 'all';
  const items = state.data.logs.filter((item) => item.message.toLowerCase().includes(query) && (level === 'all' || item.level === level));
  const colors = { success: '#10b981', info: '#6366f1', warning: '#f59e0b', error: '#f43f5e' };
  $('#log-timeline').innerHTML = items.map((item) => `<article class="timeline-item" style="--event-color:${colors[item.level] || colors.info}"><span class="timeline-time">${formatTime(item.createdAt)}</span><span class="timeline-scope status-badge ${item.level}">${escapeHtml(item.scope)}</span><strong class="timeline-message">${escapeHtml(item.message)}</strong></article>`).join('') || empty('没有匹配的事件', '调整筛选条件后重试');
}

function renderSettings() {
  const form = $('#settings-form');
  if (!document.activeElement || !form.contains(document.activeElement)) {
    Object.entries(state.data.settings).forEach(([key, value]) => {
      const field = form.elements[key];
      if (!field) return;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = value ?? '';
    });
  }
  const accountForm = $('#account-form');
  if (!document.activeElement || !accountForm.contains(document.activeElement)) {
    accountForm.elements.username.value = state.data.system.adminUser || state.auth?.username || 'admin';
  }
}

function paginate(items, requestedPage) {
  const pages = Math.max(1, Math.ceil(items.length / state.pageSize));
  const page = Math.min(requestedPage, pages);
  return { items: items.slice((page - 1) * state.pageSize, page * state.pageSize), page, pages };
}

function footer(total, page, pages, type) {
  const start = Math.max(1, Math.min(page - 2, pages - 4));
  const end = Math.min(pages, Math.max(page + 2, 5));
  const numbers = [];
  for (let number = start; number <= end; number += 1) numbers.push(number);
  const buttons = numbers.map((number) => `<button class="${number === page ? 'active' : ''}" data-page-type="${type}" data-page="${number}">${number}</button>`).join('');
  return `<span>共 ${formatNumber(total)} 条，每页 ${state.pageSize} 条，当前第 ${page}/${pages} 页</span><div class="pagination"><button data-page-type="${type}" data-page="${Math.max(1, page - 1)}" ${page === 1 ? 'disabled' : ''} aria-label="上一页">‹</button>${start > 1 ? '<button disabled>…</button>' : ''}${buttons}${end < pages ? '<button disabled>…</button>' : ''}<button data-page-type="${type}" data-page="${Math.min(pages, page + 1)}" ${page === pages ? 'disabled' : ''} aria-label="下一页">›</button></div>`;
}

function empty(title, subtitle) {
  return `<div class="empty-state"><i data-lucide="inbox"></i><strong>${title}</strong><span>${subtitle}</span></div>`;
}

function navigate(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${view}`));
  const [title, subtitle] = viewMeta[view];
  $('#page-title').textContent = title;
  $('#page-subtitle').textContent = subtitle;
  $('#sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal(type, presetIpId = '') {
  if (!productionReady()) throw new Error('当前为只读模式，Linux 生产执行环境就绪后才能创建资源');
  state.modal = type;
  const templates = {
    proxy: {
      eyebrow: 'NEW SOCKS5 INSTANCE', title: '创建 SOCKS5 实例', submit: '创建并校验', html: proxyForm()
    },
    l2tp: {
      eyebrow: 'NEW L2TP CONNECTION', title: '添加 L2TP 连接', submit: '保存连接', html: l2tpForm()
    }
  };
  const item = templates[type];
  $('#modal-eyebrow').textContent = item.eyebrow;
  $('#modal-title').textContent = item.title;
  $('#modal-submit span').textContent = item.submit;
  $('#modal-body').innerHTML = item.html;
  $('#modal-form').reset();
  if (type === 'proxy' && presetIpId) {
    const select = $('#modal-form [name="outbound"]');
    select.value = `public-ip:${presetIpId}`;
    const ip = state.data.publicIps.find((entry) => entry.id === presetIpId);
    if (ip) $('#modal-form [name="listenIp"]').value = ip.address;
  }
  $('#modal-overlay').classList.add('open');
  $('#modal-overlay').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  icons();
  setTimeout(() => $('#modal-body input, #modal-body textarea, #modal-body select')?.focus(), 150);
}

function closeModal() {
  $('#modal-overlay').classList.remove('open');
  $('#modal-overlay').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  state.modal = null;
}

function proxyForm() {
  const available = state.data.publicIps.filter((item) => !item.assignedTo);
  const l2tp = state.data.l2tp;
  const options = [
    ...available.map((item) => `<option value="public-ip:${item.id}" data-listen="${item.address}">公网 IP · ${item.address} · ${item.provider}</option>`),
    ...l2tp.map((item) => `<option value="l2tp:${item.id}">L2TP · ${escapeHtml(item.name)} · ${item.actualIp || '未拨号'}</option>`)
  ].join('');
  return `<div class="modal-grid"><label><span>实例名称</span><input class="input-control" name="name" required maxlength="40" placeholder="例如：业务线路 01"></label><label><span>出口资源</span><select class="input-control" name="outbound" required>${options || '<option value="">请先检测公网 IP 或添加 L2TP</option>'}</select></label><label><span>监听公网 IP</span><input class="input-control" name="listenIp" required value="${available[0]?.address || ''}" placeholder="由服务器网卡检测结果选择"></label><label><span>监听端口</span><input class="input-control" name="port" required type="number" min="1" max="65535" value="1080"></label><label><span>SOCKS5 用户名</span><input class="input-control" name="username" required minlength="3" maxlength="32" placeholder="client_01"></label><label><span>SOCKS5 密码</span><input class="input-control" name="password" required minlength="8" type="text" value="${randomPassword()}"><small class="field-hint">密码可在实例列表随时查看和复制</small></label><label><span>最大连接数</span><input class="input-control" name="maxConnections" type="number" min="1" max="10000" value="500"></label><label><span>带宽上限 Mbps</span><input class="input-control" name="bandwidthMbps" type="number" min="1" value="100"></label><label class="full"><span>客户端 IP 白名单</span><textarea class="input-control" name="allowlist" rows="3" placeholder="留空允许所有认证用户；多个 CIDR 每行一个"></textarea></label><label class="checkbox-field full"><input name="startNow" type="checkbox" checked> 创建后立即启动并执行出口校验</label></div>`;
}

function l2tpForm() {
  return `<div class="modal-grid"><label><span>连接名称</span><input class="input-control" name="name" required placeholder="香港线路 02"></label><label><span>L2TP 服务器</span><input class="input-control" name="server" required placeholder="vpn.example.com"></label><label><span>用户名</span><input class="input-control" name="username" required></label><label><span>密码</span><input class="input-control" name="password" required type="text"><small class="field-hint">保存后仍可按需查看和复制</small></label><label><span>MTU</span><input class="input-control" name="mtu" type="number" min="1200" max="1500" value="1400"></label><div class="security-note full"><i data-lucide="info"></i><span>当前自动部署支持普通 L2TP；L2TP/IPsec 需要按服务商参数单独接入。</span></div></div>`;
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  const values = crypto.getRandomValues(new Uint32Array(16));
  return [...values].map((value) => chars[value % chars.length]).join('');
}

async function submitModal(form) {
  const values = Object.fromEntries(new FormData(form));
  if (state.modal === 'proxy') {
    const [outboundType, outboundId] = values.outbound.split(':');
    await api('/api/proxies', { method: 'POST', body: JSON.stringify({ ...values, outboundType, outboundId, startNow: Boolean(values.startNow), allowlist: values.allowlist.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }) });
    toast('SOCKS5 实例已创建，凭据可随时查看和复制');
  } else if (state.modal === 'l2tp') {
    await api('/api/l2tp', { method: 'POST', body: JSON.stringify({ ...values, ipsec: Boolean(values.ipsec) }) });
    toast('L2TP 连接已保存');
  }
  closeModal();
  await refresh();
}

async function revealProxy(id) {
  const key = `proxy:${id}`;
  if (state.revealed.has(key)) { state.revealed.delete(key); renderProxies(); return; }
  const secret = await api(`/api/proxies/${id}/reveal-password`, { method: 'POST' });
  state.revealed.set(key, secret);
  renderProxies();
  setTimeout(() => { state.revealed.delete(key); renderProxies(); }, 60000);
}

async function revealL2tp(id) {
  const key = `l2tp:${id}`;
  if (state.revealed.has(key)) { state.revealed.delete(key); renderL2tp(); return; }
  const secret = await api(`/api/l2tp/${id}/reveal-secret`, { method: 'POST' });
  state.revealed.set(key, secret);
  renderL2tp();
  setTimeout(() => { state.revealed.delete(key); renderL2tp(); }, 60000);
}

async function copyProxy(id) {
  let secret = state.revealed.get(`proxy:${id}`);
  if (!secret) {
    secret = await api(`/api/proxies/${id}/reveal-password`, { method: 'POST' });
    state.revealed.set(`proxy:${id}`, secret);
  }
  const item = state.data.proxies.find((proxy) => proxy.id === id);
  await copyText(`socks5://${item.username}:${secret.password}@${item.listenIp}:${item.port}`);
  toast('SOCKS5 连接信息已复制');
  renderProxies();
}

async function copyL2tp(id) {
  let secret = state.revealed.get(`l2tp:${id}`);
  if (!secret) {
    secret = await api(`/api/l2tp/${id}/reveal-secret`, { method: 'POST' });
    state.revealed.set(`l2tp:${id}`, secret);
  }
  const item = state.data.l2tp.find((entry) => entry.id === id);
  const text = [`服务器: ${item.server}`, `用户名: ${item.username}`, `密码: ${secret.password}`, secret.psk ? `PSK: ${secret.psk}` : ''].filter(Boolean).join('\n');
  await copyText(text);
  toast('L2TP 凭据已复制');
  renderL2tp();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('浏览器未授权复制，请先点击查看密码后手动复制');
}

async function proxyAction(id, action) {
  await api(`/api/proxies/${id}/${action}`, { method: 'POST' });
  toast(`代理实例已${action === 'start' ? '启动' : action === 'stop' ? '停止' : action === 'restart' ? '重启' : '完成出口校验'}`);
  await refresh();
}

async function l2tpAction(id, action) {
  await api(`/api/l2tp/${id}/${action}`, { method: 'POST' });
  toast(`L2TP 线路已${action === 'connect' ? '连接' : action === 'disconnect' ? '断开' : '重拨'}`);
  await refresh();
}

async function scanNetwork() {
  const result = await api('/api/network/scan', { method: 'POST' });
  state.data = result.state;
  renderAll();
  toast(`已扫描服务器，识别到 ${result.network.interfaces.length} 个网络接口和 ${result.network.detectedPublicIps.length} 个公网 IP`);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.view) navigate(target.dataset.view);
    if (target.dataset.go) navigate(target.dataset.go);
    if (target.dataset.open) openModal(target.dataset.open);
    if (target.dataset.createWithIp) openModal('proxy', target.dataset.createWithIp);
    if (target.id === 'header-create') openModal('proxy');
    if (target.id === 'mobile-menu') $('#sidebar').classList.toggle('open');
    if (target.id === 'modal-close' || target.id === 'modal-cancel') closeModal();
    if (target.dataset.revealProxy) await revealProxy(target.dataset.revealProxy);
    if (target.dataset.copyCredential) await copyProxy(target.dataset.copyCredential);
    if (target.dataset.revealL2tp) await revealL2tp(target.dataset.revealL2tp);
    if (target.dataset.copyL2tp) await copyL2tp(target.dataset.copyL2tp);
    if (target.dataset.proxyAction) await proxyAction(target.dataset.id, target.dataset.proxyAction);
    if (target.dataset.l2tpAction) await l2tpAction(target.dataset.id, target.dataset.l2tpAction);
    if (target.dataset.deleteProxy && confirm('确定删除该 SOCKS5 实例吗？对应公网 IP 将释放回地址池。')) { await api(`/api/proxies/${target.dataset.deleteProxy}`, { method: 'DELETE' }); toast('代理实例已删除'); await refresh(); }
    if (target.dataset.deleteL2tp && confirm('确定删除该 L2TP 连接吗？')) { await api(`/api/l2tp/${target.dataset.deleteL2tp}`, { method: 'DELETE' }); toast('L2TP 连接已删除'); await refresh(); }
    if (target.dataset.pageType) { state.pages[target.dataset.pageType === 'proxy' ? 'proxies' : 'ips'] = Number(target.dataset.page); target.dataset.pageType === 'proxy' ? renderProxies() : renderIps(); }
    if (target.id === 'scan-network' || target.id === 'refresh-interfaces') await scanNetwork();
    if (target.id === 'check-all-proxies') {
      const queue = [...state.data.proxies];
      const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (queue.length) {
          const proxy = queue.shift();
          await api(`/api/proxies/${proxy.id}/check`, { method: 'POST' });
        }
      });
      await Promise.all(workers);
      toast('全部代理出口校验完成'); await refresh();
    }
    if (target.id === 'export-logs') {
      const blob = new Blob([JSON.stringify(state.data.logs, null, 2)], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `sk5-logs-${Date.now()}.json`; link.click(); URL.revokeObjectURL(link.href);
    }
    if (target.id === 'logout-button') {
      await api('/api/auth/logout', { method: 'POST' });
      location.replace('/login.html');
    }
  } catch (error) { toast(error.message, 'error'); }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'proxy-search' || event.target.id === 'proxy-status-filter') { state.pages.proxies = 1; renderProxies(); }
  if (event.target.id === 'ip-search' || event.target.id === 'ip-status-filter') { state.pages.ips = 1; renderIps(); }
  if (event.target.id === 'log-search' || event.target.id === 'log-level-filter') renderLogs();
});

document.addEventListener('change', (event) => {
  if (event.target.name === 'outbound') {
    const option = event.target.selectedOptions[0];
    if (option?.dataset.listen) $('#modal-form [name="listenIp"]').value = option.dataset.listen;
  }
});

$('#modal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#modal-submit');
  button.disabled = true;
  try { await submitModal(event.currentTarget); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ ...values, failClosed: form.elements.failClosed.checked }) });
    $('#settings-save-state').textContent = '已保存';
    toast('系统设置已保存');
    await refresh();
  } catch (error) { toast(error.message, 'error'); }
});

$('#account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.newPassword !== values.confirmPassword) return toast('两次输入的新密码不一致', 'error');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api('/api/auth/credentials', { method: 'PUT', body: JSON.stringify(values) });
    state.auth = { ...state.auth, username: result.username, csrfToken: result.csrfToken };
    state.data.system.adminUser = result.username;
    form.elements.currentPassword.value = '';
    form.elements.newPassword.value = '';
    form.elements.confirmPassword.value = '';
    $('#account-save-state').textContent = '已修改';
    $('#admin-name').textContent = result.username;
    toast('管理员登录信息已修改，其他会话已退出');
  } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
});

$('#modal-overlay').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

api('/api/auth/session').then((session) => {
  state.auth = session;
  return refresh();
}).catch((error) => {
  if (!location.pathname.endsWith('/login.html')) {
    document.body.innerHTML = `<div class="empty-state"><strong>面板加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
});
