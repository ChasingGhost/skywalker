# Skywalker Light Meter

A free, installable web app that measures light: lux, foot-candles, EV, and the camera exposure settings to use.

## Features

- **Lux and foot-candles** with a log-scale gauge, plus a level label (Dim, Indoor, Daylight…)
- **Two light sources:** the phone's ambient light sensor when the browser exposes it, otherwise the camera with its exposure locked and auto-ranged
- **Average or spot metering** (center circle), with front or back camera
- **Hold**, live **min / avg / max**, and a recent-readings chart
- **Exposure calculator:** aperture or shutter priority, ISO, ND filters, compensation, and a full table of equivalent exposures
- **Light level guide:** checks the reading against recommended lux for offices, reading, kitchens, plants and more
- **Calibration:** enter a known lux value once and the correction is saved
- **Reading log** with notes and CSV export
- Works offline, keeps the screen on while measuring, and has no ads, no account and no subscription

## Run it

Serve the folder over HTTPS (camera access needs a secure page), for example with GitHub Pages, then open it on your phone and choose "Add to Home screen".

For local testing:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Accuracy

Phone cameras are not lab meters. Readings are best with the light sensor, or with the camera after a one-time calibration against a known light level. Browsers that do not allow manual camera exposure (for example iPhone Safari) can only give a rough estimate, and the badge at the top shows this.
