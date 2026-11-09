# AI assistants (MCP)

`fairbeam mcp` lets AI assistants such as Claude Desktop, Claude Code and other
[Model Context Protocol](https://modelcontextprotocol.io) clients work with Fairbeam. An assistant can
list and read designs, create designs from starters or examples, change parameters, check a design,
run simulations, and read results. Everything stays on your computer. The server speaks MCP over
stdio, needs only Python's standard library, and calls the [run server](RUN-SERVER.md) API.

## Connect an assistant

The easiest way is **Settings › AI assistants (MCP)** in the app. It shows the exact command and
configuration for this installation, with Copy buttons.

- **Claude Code:** run the copied command in a terminal. It looks like this:

  ```bash
  claude mcp add fairbeam --scope user --env PYTHONPATH="…/Fairbeam.app/Contents/Resources/python" --env OPENEMS_INSTALL_PATH="…/runtime/openEMS" -- "…/runtime/venv/bin/python" -m fairbeam mcp
  ```

- **Claude Desktop and other clients:** add the copied JSON to the client's MCP configuration (in
  Claude Desktop: Settings › Developer › Edit config) and restart the client:

  ```json
  {"mcpServers": {"fairbeam": {"command": "…/python", "args": ["-m", "fairbeam", "mcp"],
                               "env": {"PYTHONPATH": "…", "OPENEMS_INSTALL_PATH": "…"}}}}
  ```

From a source checkout, `python -m fairbeam mcp --print-config` prints the same configuration for
the Python you run it with. The paths point to one installation. Copy them again after moving or
reinstalling Fairbeam.

## Which run server it uses

- **The open Fairbeam app** (found through its `server.json` record). Runs an assistant starts wait in
  the app's queue and appear under Recent runs. Designs it creates appear under Start › Your designs.
  You can watch, stop or open everything in the app.
- **Otherwise a server started inside `fairbeam mcp`** on a free port, working on the same workspace
  folders (`~/Documents/Fairbeam`, or `FAIRBEAM_WORKSPACE`, also from a source checkout). It keeps its own jobs folder, so opening the app later is not blocked. Pass
  `--no-embedded` to refuse this and require the app.
- **`--server URL`** (or `FAIRBEAM_SERVER`) uses a given run server.

## Tools

All values use Fairbeam's canonical units: lengths in mm, frequencies in GHz (7.1 MHz is `0.0071`).

| Tool | What it does |
| --- | --- |
| `status` | Version, run server in use, engines, CPU, workspace folders, queue |
| `list_designs` | The user's designs and the read-only examples (optional filter) |
| `get_design` | A design's JSON and hash |
| `design_format_guide` | A short guide to the design file format |
| `create_design` | A new design from a starter template, a copy of a design or example, or a full design JSON |
| `update_design` | Save an edited design; with `base_hash`, newer edits made in the app are never overwritten |
| `set_parameters` | Change parameter values or expressions and save |
| `check_design` | Build without simulating: errors, warnings, notes and mesh size |
| `render_design` | Draw the geometry as a PNG (isometric, top, front and side views; ports in red; optional mesh lines) and save it to a file |
| `estimate_run` | Before running: cells, smallest cell, timestep, expected timesteps and solver time, memory needed against free memory |
| `run_simulation` | Queue a run and, by default, wait and return the results summary |
| `run_status`, `list_runs`, `cancel_run` | Follow, list or stop runs |
| `parameter_sweep` | One run per value of one or two parameters |
| `list_results`, `get_results` | Result bundles; summary with minimum S11, −10 dB bands, Zin, VSWR, gain and efficiency, optional curves |
| `export_touchstone` | Write `.s1p` / `.sNp` next to the result or to a path |

The server also offers the design format guide as a resource (`fairbeam://guide/design-format`) and
two prompts: `design_antenna` (create, check, simulate and tune for a frequency) and
`review_result` (explain a result for an RF engineer).

## Example

> Design a half-wave dipole for 7.1 MHz in Fairbeam, run it quickly and tell me where it resonates.

The assistant can then:
1. copy the HF dipole example (`create_design` with `from_design: "hf_dipole_7mhz"`);
2. check it (`check_design`), look at it (`render_design`) and see how long it will take (`estimate_run`);
3. run it with a quick end criterion (`run_simulation`, `end_criteria_db: -40`);
4. report the minimum S11 near 7 MHz and the −10 dB band from `get_results`.

The run shows in the app while it goes.

## Limits

- Simulations run on your machine, one at a time, and take as long as they would from the app. The
  assistant waits up to `timeout_s` (default 900 s) and then returns the run id; the run goes on.
- `estimate_run` is a range from the mesh and the band, like the designer's estimate: resonant
  antennas need 15 to 80 periods of the band centre. A broadband, low-Q antenna can stop sooner (the
  7.1 MHz dipole stopped after about 9 periods), a high-Q one later.
- Results are openEMS simulations, not measurements. Mesh convergence and boundary distance decide
  how far the numbers can be trusted; the summaries say so.
- The assistant can change only designs and results in the workspace. It cannot reach other folders
  through these tools, except the path you give to `export_touchstone`.
