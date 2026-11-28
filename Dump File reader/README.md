# ME Dump Viewer

Opens MAN B&W ME engine dump files (CCU burst logs, `*CCUBurstLogger.dat`). It shows straight away what stands out, cylinder by cylinder.

**To use it:** double-click **`ME Dump Viewer.html`**. It opens in Edge or Chrome. Then drop the `.dat` files on the window, or click *Open dump files*.

- It works offline. There is nothing to install and no server to run.
- The files are read on your computer only. Nothing is uploaded.
- You can email `ME Dump Viewer.html` on its own. It holds the whole program.

Open the files of all cylinders from one dump together. The program then matches each cylinder to the firing order and compares the cylinders with each other.

## What you get

| Tab | What it shows |
|---|---|
| **Summary** | The headline ("3 things worth a look") and engine speed. Then each finding in plain words, with a *Show* button that opens the right graph. A table of cylinders: injection start, fuel plunger stroke, exhaust valve open/close/lift, FIVA delay and gap. Values that differ from the other cylinders are marked. |
| **Cylinder graphs** | Every signal of one cylinder, stacked on one time axis (FIVA set point and feedback, FIVA controller, fuel plunger, exhaust valve, engine speed). You can switch to crank angle to lay all cycles on top of each other. Step through the log cycle by cycle, and zoom by dragging. A cycle-by-cycle table sits below. |
| **Compare cylinders** | One signal for every cylinder, as an average cycle against that cylinder's own TDC. The chosen cylinder is drawn in blue and the rest in grey. Point at a grey line to see which cylinder it is. Quick zooms: injection, valve opening, valve closing. |
| **File details** | The engine: cylinder count (worked out, or set by you), firing order and TDC offsets. The files: times in local time and UTC, samples, interval. Each channel's gain, offset and range. |

Exports: the summary table as CSV, one cylinder's full data as CSV (time, crank angles, speed, every channel), and graphs as PNG. *Print summary* prints a one-page summary, or saves it as PDF.

### How the findings are worked out

Each cylinder is compared with the median of the **other** cylinders in the same dump. Starting limits (in `src/analysis.js`, `LIMITS`):

| Measure | Worth a look | Check |
|---|---|---|
| Injection start | 1.0° | 2.0° |
| Fuel plunger stroke | 5 % | 10 % |
| Exhaust valve opens | 2° | 4° |
| Exhaust valve closes | 3° | 6° |
| Exhaust valve lift | 5 % | 12 % |
| FIVA delay (slower only) | +0.75 ms | +1.5 ms |
| FIVA average gap | ×1.6 | ×2.5 |
| Cycle-to-cycle spread in one cylinder | 2° timing, 4 % stroke | 4°, 8 % |

The program also checks for:
- missed injections and exhaust valves that did not open
- signals that do not move, or that hit the logger's limit
- an engine speed that changes by more than 2% while the logs are taken

These limits are a sensible start, not MAN figures. Tune them once you have reviewed dumps from engines in good order.

Definitions:
- **Injection start**: the crank angle where the fuel plunger has moved 10% of its stroke.
- **Valve opens and closes**: the crank angle where the exhaust valve passes 10% of its lift.
- **FIVA delay**: the time shift that best lines the feedback up with the set point.
- **FIVA average gap**: the average difference between set point and feedback.

Strokes, lifts and gaps are in the logger's own units, because the file gives no units. Compare them between cylinders rather than reading them as millimetres.

## Compared with LDEPlot

`LDEPlot.exe` (MAN, version 1.3.0, 2012) opens one file per tab and draws all channels raw. It has show/hide boxes for each channel, a cursor readout (sample, value, rpm), a crank-angle axis and PDF/picture export. It works, but you have to read every trace yourself. It does not compare cylinders, measure timing or point out anything unusual.

This viewer reads the same files. It also:
- puts the ring buffer back in time order
- works out each cylinder's own TDC and the firing order
- measures every cycle and compares the cylinders
- states the result in plain words

## For developers

```
src/dumpfile.js   reads a .dat file (header, channels, ring buffer)
src/analysis.js   channel recognition, crank angle, cycles, measurements, findings
src/plot.js       canvas chart: stacked panels, crosshair, zoom, PNG
src/app.js        screens
src/index.html    page; open it directly while working on the code
src/styles.css
build.py          inlines src/ into "ME Dump Viewer.html"
tests/            node:test suite with synthetic dump files
docs/FILE_FORMAT.md  the file layout, with how sure each part is
```

- After changing anything in `src/`, run `python build.py` to rebuild `ME Dump Viewer.html`.
- Tests: `npm test` (Node 18+, no packages needed). They build synthetic dumps with a known firing order, timings and faults. They also check the sample dumps when the `.dat` files are in this folder.
- `.dat` files and `LDEPlot.exe` are kept out of git (vessel data and MAN's program).
