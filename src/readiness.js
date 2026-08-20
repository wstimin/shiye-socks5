import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const dependencies = [
  ['ip', ['/usr/bin/ip', '/usr/sbin/ip']],
  ['3proxy', ['/usr/bin/3proxy', '/usr/sbin/3proxy']],
  ['curl', ['/usr/bin/curl']],
  ['jq', ['/usr/bin/jq']],
  ['socat', ['/usr/bin/socat']],
  ['nft', ['/usr/sbin/nft', '/usr/bin/nft']],
  ['xl2tpd', ['/usr/sbin/xl2tpd']],
  ['pppd', ['/usr/sbin/pppd']],
  ['systemctl', ['/usr/bin/systemctl']],
  ['sudo', ['/usr/bin/sudo']]
];

function check(key, ok, label, detail) {
  return { key, ok: Boolean(ok), label, detail };
}

export async function evaluateReadiness({
  platform = process.platform,
  env = process.env,
  network,
  helper = env.SK5_PANEL_HELPER || '/usr/local/libexec/sk5-panel-helper',
  fileExists = (file) => fs.existsSync(file),
  canExecute = (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  runHelper = async () => execFileAsync('/usr/bin/sudo', ['-n', helper, 'system', 'check', 'readiness'], {
    timeout: 5000,
    maxBuffer: 1024 * 1024
  })
} = {}) {
  const checks = [];
  const linux = platform === 'linux';
  checks.push(check('linux', linux, 'Linux 系统', linux ? '当前系统为 Linux' : `当前系统为 ${platform}`));

  const applyRequested = env.SK5_PANEL_APPLY === 'true';
  checks.push(check('apply', applyRequested, '生产执行开关', applyRequested ? 'SK5_PANEL_APPLY 已启用' : 'SK5_PANEL_APPLY 未启用'));

  const authenticated = Boolean(env.SK5_PANEL_ADMIN_PASSWORD);
  checks.push(check('auth', authenticated, '管理员认证', authenticated ? '已配置管理员密码' : '未配置管理员密码'));

  const probeEnabled = env.SK5_PANEL_ALLOW_PROBE === 'true';
  checks.push(check('probe', probeEnabled, '真实出口探测', probeEnabled ? '已启用 curl 出口校验' : 'SK5_PANEL_ALLOW_PROBE 未启用'));

  const nativeNetwork = linux && network?.source === 'native';
  checks.push(check('network', nativeNetwork, '原生网卡检测', nativeNetwork ? '已通过 iproute2 读取网卡' : `检测来源为 ${network?.source || '不可用'}`));

  const defaultRoute = Boolean(network?.interfaces?.some((item) => item.state === 'up' && item.defaultRoute));
  checks.push(check('route', defaultRoute, '默认路由', defaultRoute ? '存在可用的默认路由' : '未检测到 UP 状态的默认路由'));

  for (const [name, candidates] of dependencies) {
    const resolved = candidates.find((candidate) => fileExists(candidate) && canExecute(candidate));
    checks.push(check(`binary:${name}`, Boolean(resolved), `依赖 ${name}`, resolved || '未找到可执行文件'));
  }

  const helperReady = linux && fileExists(helper) && canExecute(helper);
  checks.push(check('helper', helperReady, 'Root 执行助手', helperReady ? helper : 'helper 不存在或不可执行'));

  let sudoReady = false;
  let sudoDetail = '尚未执行 sudo 权限检查';
  if (linux && applyRequested && helperReady) {
    try {
      const result = await runHelper();
      const output = String(result.stdout || '').trim();
      const parsed = JSON.parse(output.split(/\r?\n/).at(-1));
      sudoReady = parsed.ready === true;
      sudoDetail = sudoReady ? 'sudoers 与 helper 自检通过' : 'helper 自检未返回 ready=true';
    } catch (error) {
      sudoDetail = `sudo/helper 自检失败：${String(error.stderr || error.message || '').trim() || '未知错误'}`;
    }
  }
  checks.push(check('sudo', sudoReady, 'Root 权限链路', sudoDetail));

  const ready = checks.every((item) => item.ok);
  return {
    ready,
    mode: ready ? 'production' : 'readonly',
    modeLabel: ready ? '生产执行模式' : '只读模式',
    message: ready
      ? 'Linux 生产执行环境已通过全部检查。'
      : '当前未连接 Linux 生产执行环境，创建和系统操作已锁定。',
    checks
  };
}

export function requireProductionReady(readiness) {
  if (readiness?.ready) return;
  const error = new Error('当前未连接 Linux 生产执行环境，已禁止创建和系统操作');
  error.statusCode = 503;
  throw error;
}
