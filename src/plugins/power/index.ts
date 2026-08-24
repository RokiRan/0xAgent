// ============================================================
// Power control module: WOL 开机 + SSH 关机，env 门禁白名单。
// 设计原则（cumora：能代码不 prompt）：
//   - 意图识别是确定性匹配，不让 LLM 猜"要不要关机"
//   - 目标由 env 白名单钉死，LLM 无法改变目标主机
//   - 只装需要该能力的 agent（目前仅 pi-agent，与 win 主机同 LAN）
// 配置：
//   POWER_HOST_NAME   显示/匹配名（如 win主机）
//   POWER_HOST_MAC    WOL 目标 MAC（如 3C:7C:3F:81:62:32）
//   POWER_HOST_IP     ping/关机目标（如 10.0.0.226）
//   POWER_HOST_SSH    SSH 目标（user@host）
//   POWER_HOST_SSH_PASS  SSH 密码（sshpass）
//   POWER_BROADCAST   WOL 广播地址（默认 10.0.0.255 + 255.255.255.255 双发）
// ============================================================

import dgram from 'node:dgram';
import { execFile } from 'node:child_process';

export interface PowerHostConfig {
  name: string;
  mac: string;
  ip: string;
  ssh: string;
  sshPass: string;
  broadcast?: string;
}

export function powerHostFromEnv(env: NodeJS.ProcessEnv = process.env): PowerHostConfig | undefined {
  const name = env.POWER_HOST_NAME?.trim();
  const mac = env.POWER_HOST_MAC?.trim();
  const ip = env.POWER_HOST_IP?.trim();
  const ssh = env.POWER_HOST_SSH?.trim();
  const sshPass = env.POWER_HOST_SSH_PASS ?? '';
  if (!name || !mac || !ip || !ssh) return undefined;
  return { name, mac, ip, ssh, sshPass, broadcast: env.POWER_BROADCAST?.trim() || undefined };
}

export type PowerAction = 'on' | 'off' | 'status';

/**
 * 确定性意图匹配：必须同时命中目标词与动作词。
 * 目标词只认 win/windows 或主机名本身——裸「主机/服务器」不算，
 * 否则「关闭 mac 主机」会把 win 主机关了（误判方向必须偏向不动作）。
 */
export function matchPowerIntent(text: string, host: PowerHostConfig): PowerAction | null {
  const t = text.toLowerCase();
  const targetHit = /win|windows/.test(t) || t.includes(host.name.toLowerCase());
  if (!targetHit) return null;
  if (/(状态|开着吗|在线吗|还活着|通不通|ping)/.test(t)) return 'status';
  if (/(关机|关闭|关掉|停电|shutdown|power\s*off|shut\s*down)/.test(t)) return 'off';
  if (/(开机|打开|启动|唤醒|wake|power\s*on|boot)/.test(t)) return 'on';
  return null;
}

/** WOL magic packet：6×FF + 16×MAC，UDP 广播 9 号端口（双广播地址兜底）。 */
export function sendWol(mac: string, broadcast = '10.0.0.255'): Promise<void> {
  const macBuf = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  if (macBuf.length !== 6) return Promise.reject(new Error(`非法 MAC: ${mac}`));
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
  const targets = [...new Set([broadcast, '255.255.255.255'])];
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      let pending = targets.length;
      let failed: unknown = null;
      for (const addr of targets) {
        sock.send(packet, 9, addr, (err) => {
          if (err) failed = err;
          if (--pending === 0) {
            sock.close();
            failed ? reject(failed) : resolve();
          }
        });
      }
    });
  });
}

function ping(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', ip], { timeout: 5000 }, (err) => resolve(!err));
  });
}

function sshShutdown(host: PowerHostConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'sshpass',
      ['-p', host.sshPass, 'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', host.ssh, 'shutdown /s /t 0'],
      { timeout: 30000 },
      (err, _stdout, stderr) => {
        // 关机命令发出后 SSH 连接可能被立即掐断——
        // 连接级错误（255/reset）不代表 shutdown 没执行，由后续 ping 判定
        if (err && !/closed|reset|255/i.test(String(err) + stderr)) reject(new Error(String(stderr || err)));
        else resolve();
      }
    );
  });
}

export async function powerExecute(host: PowerHostConfig, action: PowerAction): Promise<string> {
  if (action === 'status') {
    const alive = await ping(host.ip);
    return `${host.name}（${host.ip}）${alive ? '在线' : '离线/未响应 ping'}`;
  }
  if (action === 'on') {
    await sendWol(host.mac, host.broadcast);
    return `已向 ${host.name}（${host.mac}）发送 WOL 唤醒包，开机需要 1-2 分钟`;
  }
  // off：先确认在线，发 shutdown，再确认掉线
  const wasAlive = await ping(host.ip);
  if (!wasAlive) return `${host.name}（${host.ip}）已处于离线状态，无需关机`;
  await sshShutdown(host);
  // Windows 关机到网络掉线实测 ~15s+，8s 复查会误报"仍在线"
  await new Promise((r) => setTimeout(r, 20000));
  const stillAlive = await ping(host.ip);
  return stillAlive
    ? `已发送关机命令但 ${host.name} 仍在线，关机可能失败`
    : `已发送关机命令，${host.name}（${host.ip}）正在关机（ping 已无响应）`;
}
