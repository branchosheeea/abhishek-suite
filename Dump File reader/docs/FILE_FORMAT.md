# ME-ECS burst-log file format (`*CCUBurstLogger.dat`)

Worked out from seven CCU dumps written by `ME-ECS-SW-1609-6.4` (a 7-cylinder engine, manual dump of 15 Jun 2026). MAN's LDEPlot 1.3.0 (2012) was used as a cross-check: its strings show a sample interval in microseconds, a "Tacho X axis" and an RPM readout.

All numbers are big-endian.

| Offset | Size | Contents | Confidence |
|---|---|---|---|
| `0x000` | 4 | `02 00 01 00` in every file | Meaning unknown; probably a format version. Not used. |
| `0x004` | 64 | Logger name, NUL-terminated: `CCUBurstLogger` | Certain |
| `0x044` | 64 | Reason: `0540#Manual Dump` (code `#` text) | Certain |
| `0x084` | 64 | Control software: `ME-ECS-SW-1609-6.4` | Certain |
| `0x0C4` | 16 | Control unit: `CCU1` … `CCU7` | Certain |
| `0x0D4` | 4 + 4 | UTC time: seconds since 1970, then microseconds | Certain (matches the file names) |
| `0x0DC` | 4 + 4 | Local time: seconds, microseconds (UTC + 8 h here) | Certain |
| `0x0E4` | 2 | `4500` in every file | **Probably** the samples kept from before the trigger. Shown, not used. |
| `0x0E6` | 2 | Samples per channel: `10500` | Certain (matches the file size) |
| `0x0E8` | 2 | Ring-buffer position of the oldest sample (differs per file) | Certain: the crank angle jumps exactly here; after rotating, it is continuous |
| `0x0EA` | 2 | Number of channels: `6` | Certain |
| `0x0EC` | 4 | Sample interval in microseconds: `500` | Certain (gives 54 rpm from the crank angle, LDEPlot labels it "Sampleinterval [microseconds]") |
| `0x0F0` | 56 × channels | Channel descriptors (below) | |
| then | 2 × channels × samples | Signed 16-bit samples, one row per sample, channels side by side | Certain |
| end | 56 | Zero bytes | Not used |

The text fields hold left-over memory after the NUL byte; only the part before the first NUL is meaningful.

## Channel descriptor (56 bytes)

| Offset | Size | Contents |
|---|---|---|
| 0 | 32 | Name, NUL-terminated (`FIVA Set Point`, `Plunger Position Ch31`, `Tacho Angle Cyl. 1` …) |
| 32 | 4 | Gain, signed 16.16 fixed point (`0x00010000` = 1.0, `0x00003333` = 0.2) |
| 36 | 4 | Offset, signed 16.16 fixed point (0 in every sample) |
| 40 | 12 | Unit, NUL-terminated (`-` = none in every sample) |
| 52 | 2 | `01 02` in every channel; read as "16-bit signed". Other values give a warning. |
| 54 | 2 | Padding |

Value shown = logged number × gain + offset. Gains are snapped to 4 decimals when that is within the 16.16 resolution, so 0.2 shows as 0.2, not 0.19999695.

## Ring buffer

The logger writes round a ring of `samples` slots. The field at `0x0E8` is where the oldest sample sits, so time order is

```
stored[ringStart], stored[ringStart+1], …, stored[samples-1], stored[0], …, stored[ringStart-1]
```

Without this step the crank angle jumps once in the middle of the log (for example 357° → 89° in the CCU1 sample).

## Crank angle

`Tacho Angle Cyl. 1` counts whole degrees from **cylinder 1 TDC** in every CCU file. Each cylinder's own TDC is a whole multiple of 360/N degrees later; the program finds the multiple from where that cylinder's injections start. For the sample engine this gives the firing order 1-7-2-5-4-3-6 and injection starting within 0.2° of each cylinder's own TDC.

The fine angle used for timing is drawn through the middle of each 1° step. That makes it agree with the logged value on average. Differences between cylinders are good to about 0.1°. The absolute angle is good to about ±0.5°, because the file does not say whether the logger rounds or truncates.

## Open questions

- What `0x0E4` (4500) means for sure, and where the trigger sits in the log.
- Whether other ME-ECS software versions or other loggers (ECU, ACU, alarm-triggered dumps) use the same layout. The reader checks sizes and refuses files that do not fit, with a plain message.
- What the logged units are (none are given in the file). The program treats strokes, lifts and FIVA values as logger units and only compares them between cylinders.
