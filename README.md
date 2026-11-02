# webzer

A small web app that shows battery, onboard profile, DPI and EQ preset for two Razer devices, without Synapse.

| Device | USB ID | Shows |
|---|---|---|
| Viper V3 Pro | `1532:00C0` (cable), `1532:00C1` (dongle) | Battery, charging, onboard profile, DPI and DPI stages, polling rate |
| BlackShark V2 Pro (2023) | `1532:0555` | Battery, charging, EQ preset, which you can switch (Game, Music, Movie, Custom and five esports presets) |

## How it works

A Python helper talks to the devices over HID. It serves the page and a JSON API on `localhost:8137`.
The page only calls `fetch`, so any browser works.

```
browser  --HTTP-->  razer_helper.py  --HID-->  mouse / headset
```

The helper exists because Chrome's WebHID can't reach the mouse's Razer commands. The mouse answers them
only on its Generic Desktop / Mouse collection. On the cable and the dongle, Chrome hides that collection and
exposes no feature reports, so sending one fails with `NotAllowedError`.
The headset's vendor interface (usage page `0xFF00`) is open to WebHID, but the helper handles it too, so one
page covers both devices in any browser.

## Run

You need [uv](https://docs.astral.sh/uv/). Quit Razer Synapse first, because it uses the same HID channel.

```bash
uv run razer_helper.py
```

Then type http://localhost:8137 into the address bar, or use a bookmark.
A link to it from another website gets a 403. See [Security](#security).

If the mouse is asleep, its card shows `no interface answered (read error)`. Move the mouse and click **Refresh**.

`uv run razer_helper.py --once` prints the status JSON and exits.

## Docker

The image works on Linux hosts only. Docker Desktop on Windows and macOS can't see USB HID devices, so use `uv run` there.

```bash
docker run --rm -p 127.0.0.1:8137:8137 \
  -v /run/udev:/run/udev:ro \
  $(for d in /dev/hidraw*; do echo --device "$d"; done) \
  ghcr.io/dbeilin/webzer:latest
```

Docker passes the device nodes in when the container starts. If you plug in a device later, restart the container.
Inside the container the helper listens on all interfaces, so keep the `127.0.0.1:` prefix on `-p`.

The image has `linux/amd64` and `linux/arm64` variants, and these tags:

| Tag | Points to |
|---|---|
| `latest` | The newest release tag |
| `0.1.0`, `0.1` | A release tag |
| `edge` | The newest commit on `main` |
| `sha-abc1234` | One commit |

`docker build -t webzer .` builds the image locally.

CI builds and tests the image on every pull request and on every push to `main` and to release tags.
It publishes the image only after the tests pass, and never from a pull request. See `.github/workflows/docker.yml`.

## API

| Method | Path | Does |
|---|---|---|
| GET | `/api/status` | Returns everything the page shows, as JSON |
| POST | `/api/headset/preset?id=8` | Switches the EQ preset: 7 Game, 8 Music, 9 Movie, 250 to 254 esports, 255 Custom |
| GET | `/api/mouse/raw?class=05&id=8a&size=0a` | Sends one Razer mouse read command and returns the 80 argument bytes |
| GET | `/api/headset/raw?cmd=13` | Sends one headset query and returns the reply payload, or `null` |

`/api/mouse/raw` takes hex values. It accepts only read commands (`id` of `80` or more).
`size` defaults to `10`, `args` takes hex bytes such as `01,02`, and `conn=wireless` sends to the dongle instead of the cable.

A failed command returns status 500 and `{"error": "..."}`.

## Security

The helper listens on `127.0.0.1` and answers only its own page and local tools such as `curl`. It returns 403 when:

- the `Host` header isn't `localhost`, `127.0.0.1` or `[::1]`, which stops DNS rebinding,
- an `Origin` header is present and differs from `Host`,
- `Sec-Fetch-Site` is anything other than `same-origin` or `none`, so a request or a link from another site,
  or from another port on localhost, is refused.

`tests/test_request_guard.py` checks each rule. Run it with `uv run python -m unittest tests.test_request_guard`.

## Protocol notes

- **Mouse.** 90-byte feature reports, as documented by [OpenRazer](https://github.com/openrazer/openrazer).
  Razer commands go to feature report 0 on interface 0, the Generic Desktop / Mouse collection. No other
  collection answers them, on the cable or through the dongle.
  The onboard profile comes from command class `0x05`, which is undocumented. On a Viper V3 Pro with one stored
  profile, `0x05:0x8A` reads 1 and `0x05:0x81` reads one entry, profile 1. A mouse with several stored profiles
  hasn't been tested, so it's unconfirmed that `0x8A` follows the active one.
- **Headset.** The "PA" protocol on the `0xFF00` interface, from
  [HaloBattery](https://github.com/HeyOkay/HaloBattery) and
  [OpenRazer PR #2862](https://github.com/openrazer/openrazer/pull/2862).
- **Esports preset names are a guess.** Reviews name five games (Apex Legends, Call of Duty, Counter-Strike,
  Fortnite and Valorant), and the code assumes Synapse lists them in alphabetical order.
  The headset accepts all five wire values (250 to 254) and reads each one back, but it doesn't report names.
  If the names are wrong, edit `PRESETS` in `razer_helper.py`.
- `web/probe.html` is a WebHID test page. It lists the HID collections Chrome exposes and sends raw commands.
  It was used to work out the protocols.
