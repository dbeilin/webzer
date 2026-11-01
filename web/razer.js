// Razer HID protocol (mice): 90-byte feature reports on report ID 0.
// Layout as documented by the openrazer project.

export const RAZER_VID = 0x1532;
export const REPORT_LEN = 90;

export const STATUS = {
  0x00: 'new',
  0x01: 'busy',
  0x02: 'ok',
  0x03: 'failed',
  0x04: 'timeout (device asleep / out of range?)',
  0x05: 'not supported',
};

// Transaction IDs seen across Razer devices; newer mice mostly use 0x1F.
export const TRANSACTION_IDS = [0x1f, 0xff, 0x3f, 0x9f, 0x08];

const h2 = (n) => n.toString(16).padStart(2, '0');
export const hx = (n) => '0x' + h2(n).toUpperCase();

// Hex dump that collapses trailing zero padding.
export function hex(bytes, trim = true) {
  let end = bytes.length;
  if (trim) while (end > 0 && bytes[end - 1] === 0) end--;
  const s = Array.from(bytes.subarray(0, end), (b) => h2(b)).join(' ');
  if (!trim || end === bytes.length) return s;
  return `${s}${end ? ' ' : ''}… (${bytes.length - end} × 00)`;
}

export function crc(p) {
  let c = 0;
  for (let i = 2; i < 88; i++) c ^= p[i];
  return c;
}

export function buildPacket({ transactionId, cmdClass, cmdId, size, args = [] }) {
  const p = new Uint8Array(REPORT_LEN);
  p[1] = transactionId;
  p[5] = size;
  p[6] = cmdClass;
  p[7] = cmdId;
  p.set(args.slice(0, 80), 8);
  p[88] = crc(p);
  return p;
}

// Chrome may or may not prefix the report ID byte, so look for the packet at offset 0 or 1.
export function parsePacket(bytes, cmdClass, cmdId) {
  for (const off of [0, 1]) {
    if (bytes.length < off + REPORT_LEN) continue;
    const p = bytes.subarray(off, off + REPORT_LEN);
    if (p[6] !== cmdClass || p[7] !== cmdId) continue;
    return {
      status: p[0],
      statusText: STATUS[p[0]] ?? `unknown (${hx(p[0])})`,
      transactionId: p[1],
      size: p[5],
      args: p.subarray(8, 88),
      crcOk: crc(p) === p[88],
      raw: p,
    };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send one command and poll for the reply while the device reports "busy".
export async function transact(device, req, { delay = 40, retries = 12 } = {}) {
  const sent = buildPacket(req);
  await device.sendFeatureReport(0, sent);
  let raw = null;
  let res = null;
  for (let i = 0; i < retries; i++) {
    await sleep(delay);
    const view = await device.receiveFeatureReport(0);
    raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    res = parsePacket(raw, req.cmdClass, req.cmdId);
    if (res && res.status !== 0x01) break;
  }
  return { sent, raw, res };
}

const POLL = { 0x01: 1000, 0x02: 500, 0x08: 125 };
const POLL2 = { 0x01: 8000, 0x02: 4000, 0x04: 2000, 0x08: 1000, 0x10: 500, 0x40: 125 };
const be16 = (a, i) => (a[i] << 8) | a[i + 1];

export const COMMANDS = {
  battery: {
    label: 'Battery',
    cmdClass: 0x07, cmdId: 0x80, size: 0x02,
    decode: (a) => `${Math.round((a[1] / 255) * 100)}% (raw ${a[1]})`,
  },
  charging: {
    label: 'Charging',
    cmdClass: 0x07, cmdId: 0x84, size: 0x02,
    decode: (a) => (a[1] ? 'charging' : 'not charging'),
  },
  firmware: {
    label: 'Firmware',
    cmdClass: 0x00, cmdId: 0x81, size: 0x02,
    decode: (a) => `v${a[0]}.${a[1]}`,
  },
  serial: {
    label: 'Serial',
    cmdClass: 0x00, cmdId: 0x82, size: 0x16,
    decode: (a) => String.fromCharCode(...a.subarray(0, 22)).replace(/\0.*$/, ''),
  },
  deviceMode: {
    label: 'Device mode',
    cmdClass: 0x00, cmdId: 0x84, size: 0x02,
    decode: (a) => ({ 0x00: 'normal', 0x03: 'driver' })[a[0]] ?? hx(a[0]),
  },
  pollingRate: {
    label: 'Polling rate',
    cmdClass: 0x00, cmdId: 0x85, size: 0x01,
    decode: (a) => (POLL[a[0]] ? `${POLL[a[0]]} Hz` : `raw ${hx(a[0])}`),
  },
  pollingRate2: {
    label: 'Polling rate (HyperPolling)',
    cmdClass: 0x00, cmdId: 0xc0, size: 0x01,
    decode: (a) => (POLL2[a[1]] ? `${POLL2[a[1]]} Hz` : `raw ${hx(a[0])} ${hx(a[1])}`),
  },
  dpi: {
    label: 'Current DPI',
    cmdClass: 0x04, cmdId: 0x85, size: 0x07, args: [0x01],
    decode: (a) => `storage ${hx(a[0])}: ${be16(a, 1)} × ${be16(a, 3)}`,
  },
  dpiStages: {
    label: 'DPI stages',
    cmdClass: 0x04, cmdId: 0x86, size: 0x26, args: [0x01],
    decode: (a) => {
      const stages = [];
      for (let i = 0; i < a[2] && i < 5; i++) {
        const o = 3 + i * 7;
        stages.push(`#${a[o]} ${be16(a, o + 1)}×${be16(a, o + 3)}`);
      }
      return `storage ${hx(a[0])}, active stage ${a[1]}, ${a[2]} stages: ${stages.join(', ')}`;
    },
  },
};
