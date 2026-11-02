import { RAZER_VID, TRANSACTION_IDS, COMMANDS, hex, hx, transact } from './razer.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
let devices = [];
let lastOkTid = null;
const listening = new WeakSet();

function log(msg, kind = '') {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// Run actions one at a time so device replies don't interleave.
let queue = Promise.resolve();
function run(fn) {
  queue = queue.then(fn).catch((e) => log(`ERROR ${e.name}: ${e.message}`, 'err'));
}

const reportBytes = (r) => Math.ceil(r.items.reduce((s, i) => s + i.reportSize * i.reportCount, 0) / 8);
const devName = (d) => `${d.productName || 'Unknown'} [${hx(d.productId >> 8)}${hx(d.productId & 0xff).slice(2)}]`;

function usageName(page, usage) {
  if (page === 0x01) {
    const u = { 0x01: 'Pointer', 0x02: 'Mouse', 0x06: 'Keyboard', 0x80: 'System Control' }[usage];
    return `Generic Desktop${u ? ' / ' + u : ''}`;
  }
  if (page === 0x0c) return 'Consumer Control';
  if (page === 0x0b) return 'Telephony';
  if (page >= 0xff00) return 'Vendor-defined';
  return '';
}

function flatCollections(cols, depth = 0, out = []) {
  for (const c of cols) {
    out.push({ c, depth });
    flatCollections(c.children || [], depth + 1, out);
  }
  return out;
}

function featureIds(d) {
  const ids = new Set();
  for (const { c } of flatCollections(d.collections)) for (const r of c.featureReports) ids.add(r.reportId);
  return [...ids];
}

function describe(d) {
  return {
    productName: d.productName,
    vendorId: hx(d.vendorId),
    productId: '0x' + d.productId.toString(16).padStart(4, '0').toUpperCase(),
    opened: d.opened,
    collections: flatCollections(d.collections).map(({ c, depth }) => ({
      depth,
      usagePage: '0x' + c.usagePage.toString(16).toUpperCase(),
      usage: hx(c.usage),
      name: usageName(c.usagePage, c.usage),
      input: c.inputReports.map((r) => `id ${r.reportId}: ${reportBytes(r)}B`),
      output: c.outputReports.map((r) => `id ${r.reportId}: ${reportBytes(r)}B`),
      feature: c.featureReports.map((r) => `id ${r.reportId}: ${reportBytes(r)}B`),
    })),
  };
}

function render() {
  const wrap = $('devices');
  wrap.replaceChildren();
  if (!devices.length) {
    wrap.innerHTML = '<p class="hint">No Razer devices permitted yet.</p>';
  }
  devices.forEach((d, i) => {
    const info = describe(d);
    const card = document.createElement('div');
    card.className = 'card';
    const rows = info.collections
      .map(
        (c) => `<tr><td style="padding-left:${0.5 + c.depth}rem">${c.usagePage} / ${c.usage}</td><td>${c.name}</td>
        <td>${c.input.join('<br>') || '–'}</td><td>${c.output.join('<br>') || '–'}</td>
        <td class="${c.feature.length ? 'good' : ''}">${c.feature.join('<br>') || '–'}</td></tr>`
      )
      .join('');
    card.innerHTML = `<h3>#${i} ${info.productName || 'Unknown'} <span class="mono">${info.vendorId}:${info.productId}</span></h3>
      <table><thead><tr><th>Usage page / usage</th><th>Type</th><th>Input</th><th>Output</th><th>Feature</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No collections exposed (Chrome or Windows is hiding them)</td></tr>'}</tbody></table>`;
    wrap.append(card);
  });

  const target = $('target');
  const prev = target.value;
  target.replaceChildren(
    ...devices.map((d, i) => {
      const o = document.createElement('option');
      o.value = i;
      const f = featureIds(d);
      o.textContent = `#${i} ${devName(d)}${f.length ? ' — feature reports ' + f.join(',') : ' — no feature reports'}`;
      return o;
    })
  );
  // Razer commands go to feature report 0.
  const best = devices.findIndex((d) => featureIds(d).includes(0));
  target.value = prev && devices[prev] ? prev : String(best >= 0 ? best : 0);
}

async function refresh() {
  devices = (await navigator.hid.getDevices()).filter((d) => d.vendorId === RAZER_VID);
  render();
}

async function ensureOpen(d) {
  if (!d.opened) await d.open();
  if (!listening.has(d)) {
    listening.add(d);
    let last = '';
    d.addEventListener('inputreport', (e) => {
      if (!$('logInput').checked) return;
      const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      const s = `input ← ${devName(d)} report ${e.reportId}: ${hex(bytes)}`;
      if (s === last) return;
      last = s;
      log(s, 'in');
    });
  }
}

function targetDevice() {
  const d = devices[Number($('target').value)];
  if (!d) throw new Error('No target device. Add a device first.');
  return d;
}

async function razer(d, cmd, { args, label } = {}) {
  await ensureOpen(d);
  const tidSel = $('tid').value;
  const tids = tidSel === 'auto' ? (lastOkTid != null ? [lastOkTid, ...TRANSACTION_IDS.filter((t) => t !== lastOkTid)] : TRANSACTION_IDS) : [Number(tidSel)];
  const name = label ?? cmd.label ?? `${hx(cmd.cmdClass)} ${hx(cmd.cmdId)}`;
  let lastOut = null;
  for (const tid of tids) {
    const out = await transact(d, { ...cmd, args: args ?? cmd.args ?? [], transactionId: tid });
    lastOut = out;
    if (out.res && out.res.status === 0x02) {
      lastOkTid = tid;
      const value = cmd.decode ? cmd.decode(out.res.args) : hex(out.res.args);
      log(`${name}: ${value}   [tid ${hx(tid)}, ${devName(d)}]`, 'ok');
      log(`   → ${hex(out.sent)}\n   ← ${hex(out.res.raw)}`, 'dim');
      return out;
    }
  }
  const r = lastOut?.res;
  log(`${name}: no good reply — ${r ? 'status ' + r.statusText : 'reply did not echo the command'}  [${devName(d)}]`, 'warn');
  if (lastOut) log(`   → ${hex(lastOut.sent)}\n   ← ${lastOut.raw ? hex(lastOut.raw) : '(nothing)'}`, 'dim');
  return lastOut;
}

function setupEnv() {
  const env = $('env');
  const problems = [];
  if (!('hid' in navigator)) problems.push('This browser has no WebHID. Open this page in Chrome or Edge.');
  if (!window.isSecureContext) problems.push('Not a secure context. Open it via http://localhost, not a plain file or LAN address.');
  env.className = problems.length ? 'banner bad' : 'banner goodbg';
  env.textContent = problems.length ? problems.join(' ') : 'WebHID available. Quit Razer Synapse fully before testing.';
  return !problems.length;
}

function setupButtons() {
  const box = $('mouseCmds');
  for (const [key, cmd] of Object.entries(COMMANDS)) {
    const b = document.createElement('button');
    b.textContent = cmd.label;
    b.onclick = () => run(() => razer(targetDevice(), cmd));
    box.append(b);
    if (key === 'charging') box.append(document.createElement('wbr'));
  }

  $('connect').onclick = () =>
    run(async () => {
      const picked = await navigator.hid.requestDevice({ filters: [{ vendorId: RAZER_VID }] });
      for (const d of picked) log(`Permitted: ${devName(d)} (${d.collections.length} top-level collections)`);
      await refresh();
    });

  $('allMouse').onclick = () =>
    run(async () => {
      const d = targetDevice();
      for (const cmd of Object.values(COMMANDS)) await razer(d, cmd);
    });

  $('batteryAll').onclick = () =>
    run(async () => {
      for (const d of devices) {
        try {
          await razer(d, COMMANDS.battery);
        } catch (e) {
          log(`Battery on ${devName(d)}: ${e.name}: ${e.message}`, 'warn');
        }
      }
    });

  $('dpiSlots').onclick = () =>
    run(async () => {
      const d = targetDevice();
      for (let s = 0; s <= 5; s++) await razer(d, COMMANDS.dpi, { args: [s], label: `DPI, storage ${s}` });
    });

  $('stagesSlots').onclick = () =>
    run(async () => {
      const d = targetDevice();
      for (let s = 0; s <= 5; s++) await razer(d, COMMANDS.dpiStages, { args: [s], label: `DPI stages, storage ${s}` });
    });

  $('readFeatures').onclick = () =>
    run(async () => {
      const d = targetDevice();
      await ensureOpen(d);
      const ids = featureIds(d);
      if (!ids.length) log(`${devName(d)} exposes no feature reports.`, 'warn');
      for (const id of ids) {
        try {
          const v = await d.receiveFeatureReport(id);
          log(`feature ${id} ← ${devName(d)}: ${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`, 'in');
        } catch (e) {
          log(`feature ${id} on ${devName(d)}: ${e.name}: ${e.message}`, 'warn');
        }
      }
    });

  $('openAll').onclick = () =>
    run(async () => {
      for (const d of devices) {
        try {
          await ensureOpen(d);
          log(`Listening on ${devName(d)}`);
        } catch (e) {
          log(`Open ${devName(d)}: ${e.name}: ${e.message}`, 'warn');
        }
      }
      render();
    });

  const parseBytes = (s) =>
    s.trim() ? s.trim().split(/[\s,]+/).map((t) => {
      const n = parseInt(t.replace(/^0x/i, ''), 16);
      if (Number.isNaN(n) || n > 255) throw new Error(`Bad byte "${t}"`);
      return n;
    }) : [];
  const num = (id) => parseInt($(id).value.replace(/^0x/i, ''), 16);

  $('rzSend').onclick = () =>
    run(() => razer(targetDevice(), { cmdClass: num('rzClass'), cmdId: num('rzId'), size: num('rzSize') }, { args: parseBytes($('rzArgs').value) }));

  $('rzScan').onclick = () =>
    run(async () => {
      const d = targetDevice();
      const cls = num('rzClass');
      for (let id = 0x80; id <= 0x8f; id++)
        await razer(d, { cmdClass: cls, cmdId: id, size: num('rzSize') }, { args: parseBytes($('rzArgs').value) });
    });

  $('rawSend').onclick = () =>
    run(async () => {
      const d = targetDevice();
      await ensureOpen(d);
      const id = Number($('rawId').value);
      const data = new Uint8Array(parseBytes($('rawBytes').value));
      if ($('rawType').value === 'feature') await d.sendFeatureReport(id, data);
      else await d.sendReport(id, data);
      log(`${$('rawType').value} ${id} → ${devName(d)}: ${hex(data, false)}`);
    });

  $('copyLog').onclick = () => navigator.clipboard.writeText(logEl.innerText).then(() => log('Log copied.'));
  $('copyInfo').onclick = () =>
    navigator.clipboard.writeText(JSON.stringify(devices.map(describe), null, 2)).then(() => log('Device info copied.'));
  $('clearLog').onclick = () => logEl.replaceChildren();
}

if (setupEnv()) {
  setupButtons();
  navigator.hid.addEventListener('connect', (e) => (log(`Connected: ${devName(e.device)}`), refresh()));
  navigator.hid.addEventListener('disconnect', (e) => (log(`Disconnected: ${devName(e.device)}`), refresh()));
  refresh();
} else {
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
}
