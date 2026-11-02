const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function batteryBlock(level, charging) {
  const tone = level <= 15 ? 'low' : level <= 30 ? 'mid' : '';
  return `<div class="${tone}">
      <div class="battery"><span class="pct">${level}%</span>
        <span class="chg ${charging ? 'on' : ''}">${charging ? '⚡ Charging' : 'On battery'}</span></div>
      <div class="bar"><div style="width:${Math.max(level, 2)}%"></div></div>
    </div>`;
}

function card(title, pills, body) {
  return `<h2>${title}</h2><div class="sub">${pills.map((p) => `<span class="pill">${esc(p)}</span>`).join('')}</div>${body}`;
}

function renderMouse(mice) {
  const el = $('mouse');
  if (!mice.length) {
    el.innerHTML = card('Viper V3 Pro', [], '<p class="empty">Not connected. Plug in the cable or the dongle.</p>');
    return;
  }
  // With the cable and the dongle both plugged in there are two entries. Show the one that answered.
  const m = mice.find((x) => x.battery != null) ?? mice[0];
  const conn = mice.map((x) => (x.connection === 'wired' ? 'Cable' : 'Wireless')).join(' + ');
  if (m.error) {
    el.innerHTML = card('Viper V3 Pro', [conn], `<p class="empty">Mouse didn't answer.</p><p class="err">${esc(m.error)}</p>`);
    return;
  }
  const s = m.dpiStages;
  const stages = s
    ? `<div class="stages">${s.stages
        .map((st) => `<span class="stage ${st.id === s.active ? 'active' : ''}">${st.x === st.y ? st.x : `${st.x}×${st.y}`}</span>`)
        .join('')}</div>`
    : '–';
  const errors = m.errors ? `<p class="err">${Object.entries(m.errors).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>')}</p>` : '';
  el.innerHTML = card(
    'Viper V3 Pro',
    [conn, m.firmware ?? ''].filter(Boolean),
    `${m.battery != null ? batteryBlock(m.battery, m.charging) : '<p class="empty">Battery unavailable</p>'}
     <dl>
       <dt>Profile</dt><dd>${m.profile != null ? `Onboard ${m.profile}${m.profiles?.length > 1 ? ` of ${m.profiles.length}` : ''}` : '–'}</dd>
       <dt>DPI</dt><dd>${m.dpi ? (m.dpi[0] === m.dpi[1] ? m.dpi[0] : m.dpi.join(' × ')) : '–'}</dd>
       <dt>Stages</dt><dd>${stages}</dd>
       <dt>Polling</dt><dd>${m.pollingRate ? `${m.pollingRate} Hz` : '–'}</dd>
     </dl>${errors}`
  );
}

function renderHeadset(h) {
  const el = $('headset');
  if (!h) {
    el.innerHTML = card('BlackShark V2 Pro', [], '<p class="empty">Dongle not plugged in.</p>');
  } else if (h.error) {
    el.innerHTML = card('BlackShark V2 Pro', [], `<p class="empty">Couldn't read the headset.</p><p class="err">${esc(h.error)}</p>`);
  } else if (!h.online) {
    el.innerHTML = card('BlackShark V2 Pro', ['Wireless'], '<p class="empty">Headset is off or out of range.</p>');
  } else {
    el.innerHTML = card(
      'BlackShark V2 Pro',
      ['Wireless', h.firmware ?? ''].filter(Boolean),
      `${batteryBlock(h.battery, h.charging)}
       <dl><dt>Sound profile</dt><dd>${esc(h.preset ?? '–')}</dd></dl>
       ${presetPicker(h.presets ?? [], h.presetId)}
       <p class="err" id="presetErr"></p>`
    );
  }
}

const isEsports = (id) => id >= 0xfa && id <= 0xfe;

function presetPicker(presets, active) {
  const chips = (list) =>
    list
      .map((p) => `<button class="chip ${p.id === active ? 'active' : ''}" data-preset="${p.id}">${esc(p.name)}</button>`)
      .join('');
  return `<div class="presets">
      <div class="group">Standard</div><div class="chips">${chips(presets.filter((p) => !isEsports(p.id)))}</div>
      <div class="group">Esports</div><div class="chips">${chips(presets.filter((p) => isEsports(p.id)))}</div>
    </div>`;
}

async function setPreset(btn) {
  if (busy) return;
  busy = true;
  const chips = $('headset').querySelectorAll('.chip');
  chips.forEach((c) => (c.disabled = true));
  btn.classList.add('pending');
  try {
    const res = await fetch(`/api/headset/preset?id=${btn.dataset.preset}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    chips.forEach((c) => c.classList.toggle('active', Number(c.dataset.preset) === data.presetId));
    $('headset').querySelector('dd').textContent = data.preset;
  } catch (e) {
    $('presetErr').textContent = `Couldn't switch: ${e.message}`;
  } finally {
    btn.classList.remove('pending');
    chips.forEach((c) => (c.disabled = false));
    busy = false;
  }
}

$('headset').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (btn && !btn.classList.contains('active')) setPreset(btn);
});

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    $('banner').innerHTML = '';
    renderMouse(data.mice);
    renderHeadset(data.headset);
    $('updated').textContent = `Updated ${new Date(data.time * 1000).toLocaleTimeString()}`;
  } catch (e) {
    $('banner').innerHTML = `<div class="banner">Can't reach the helper (${esc(e.message)}). Start it with <code>uv run razer_helper.py</code>.</div>`;
  } finally {
    busy = false;
    $('refresh').disabled = false;
  }
}

$('refresh').onclick = refresh;
refresh();
setInterval(refresh, REFRESH_MS);
