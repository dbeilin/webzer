# webzer

A small web app for Razer devices: battery, profiles and EQ presets, without Synapse.

Supported devices:

| Device | USB ID | Shows |
|---|---|---|
| Viper V3 Pro | `1532:00C0` (cable), `1532:00C1` (dongle) | Battery, charging, onboard profile, DPI and DPI stages, polling rate |
| BlackShark V2 Pro (2023) | `1532:0555` | Battery, charging, EQ preset (switchable: Game, Music, Movie, Custom, five esports presets) |

## How it works

Browsers can't send Razer's mouse commands: Windows and Chrome protect mouse interfaces from WebHID.
So a small Python helper talks to the devices over HID and serves both the page and a JSON API on
`localhost:8137`.

```
browser  ──HTTP──▶  razer_helper.py  ──HID──▶  mouse / headset
```

## Run

Requires [uv](https://docs.astral.sh/uv/). Quit Razer Synapse first, because it uses the same HID channel.

```bash
uv run razer_helper.py
```

Then open http://localhost:8137.

## Docker

The image runs on **Linux hosts only**. Docker Desktop on Windows and macOS can't see USB HID devices,
so use `uv run` there.

```bash
docker build -t webzer .
docker run --rm -p 127.0.0.1:8137:8137 \
  -v /run/udev:/run/udev:ro \
  $(for d in /dev/hidraw*; do echo --device "$d"; done) \
  webzer
```

Device nodes are passed in when the container starts, so restart it after plugging in a device.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/status` | Everything the page shows, as JSON |
| POST | `/api/headset/preset?id=8` | Switch EQ preset (7 Game, 8 Music, 9 Movie, 250–254 esports, 255 Custom) |
| GET | `/api/mouse/raw?class=05&id=8a&size=0a` | Send one Razer mouse read command (ids ≥ 0x80 only) |
| GET | `/api/headset/raw?cmd=13` | Send one headset query |

`uv run razer_helper.py --once` prints the status JSON and exits.

## Notes

- **Mouse protocol:** 90-byte feature reports as documented by [OpenRazer](https://github.com/openrazer/openrazer).
  The onboard profile comes from command class `0x05`, which is undocumented. Its meaning was inferred
  from a mouse with one stored profile.
- **Headset protocol:** the "PA" protocol on the `0xFF00` interface, from
  [HaloBattery](https://github.com/HeyOkay/HaloBattery) and
  [OpenRazer PR #2862](https://github.com/openrazer/openrazer/pull/2862).
- **Esports preset names** are a guess: reviews list Apex Legends, Call of Duty, CS:GO, Fortnite and
  Valorant, assumed to be in alphabetical order. Rename them in `PRESETS` in `razer_helper.py`.
- `web/probe.html` is a WebHID test page that lists what Chrome can see, used while figuring out the protocols.
