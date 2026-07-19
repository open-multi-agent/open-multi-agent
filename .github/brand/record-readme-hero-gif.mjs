#!/usr/bin/env node

/**
 * README hero GIF recorder
 *
 * Replays a scripted interaction over the committed Run Viewer snapshot
 * (run-viewer-hero.html, produced by capture-hero-run.mts) and encodes the
 * frames into the README hero GIF. The page is rendered with
 * `reduced_motion: reduce`, so every interaction paints synchronously and the
 * frame sequence is fully deterministic — the last frame returns to the first
 * frame's state, which makes the GIF loop seamless.
 *
 * Prerequisites: python3 with Playwright (chromium) and ffmpeg on PATH.
 *
 * Usage:
 *   node .github/brand/record-readme-hero-gif.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const INPUT_HTML = join(SCRIPT_DIR, 'run-viewer-hero.html')
const WORK_DIR = join(SCRIPT_DIR, 'frames', 'readme-hero-gif')
const FRAMES_DIR = join(WORK_DIR, 'screenshots')

const OUTPUT_GIF = join(SCRIPT_DIR, 'demo-dashboard-hero.gif')
const OUTPUT_GIF_1200 = join(SCRIPT_DIR, 'demo-dashboard-hero-1200.gif')
const OUTPUT_MP4 = join(SCRIPT_DIR, 'demo-dashboard-hero.mp4')

const WIDTH = 1600
const HEIGHT = 900
const FPS = 12
const DURATION_SECONDS = 9.5
const FRAME_COUNT = Math.round(FPS * DURATION_SECONDS)
const README_GIF_LIMIT_BYTES = 8 * 1024 * 1024

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

// ---------------------------------------------------------------------------
// Frame capture — Playwright drives the real page, one deterministic step per
// frame. Timeline (seconds → beat):
//   0.0  S0: DAG fit view, first task selected (loop entry, held ~1s)
//   0.9  select a parallel-branch task (details panel updates)
//   1.6  smooth wheel zoom onto the parallel column (13 frames)
//   2.75 select the sibling parallel task
//   4.0  switch to the Waterfall tab (auto-centers the selected span)
//   4.7  eased scroll toward the first tool span (19 frames)
//   6.5  select the tool span (details panel shows tool evidence)
//   7.5  switch back to DAG (fitDag restores the exact fit transform)
//   8.0  reselect the first task → state S0 again (held to the end)
// ---------------------------------------------------------------------------
const captureScript = String.raw`
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

html_path, frames_dir, width, height, fps = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]),
)
frames_root = Path(frames_dir)
frames_root.mkdir(parents=True, exist_ok=True)


def frame_at(seconds):
    return round(seconds * fps)


TOTAL = frame_at(9.5)
NEUTRAL = (700, 52)  # parked cursor spot in the masthead; no hover styles there


def smoothstep(t):
    return t * t * (3 - 2 * t)


with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(
        viewport={"width": width, "height": height},
        device_scale_factor=1,
        color_scheme="dark",
        reduced_motion="reduce",
    )
    page = context.new_page()
    page.goto(Path(html_path).resolve().as_uri())
    page.wait_for_selector(".dag-node")

    def flush():
        # Queue behind the page's own setTimeout(..., 0) callbacks (fitDag /
        # scrollSelectedWaterfall) so they have run before we screenshot.
        page.evaluate("() => new Promise(resolve => setTimeout(resolve, 0))")

    flush()

    payload = page.evaluate(
        "() => JSON.parse(document.getElementById('oma-data').textContent)"
    )
    tasks = payload["tasks"]
    positions = payload["dag"]["positions"]
    ordered = sorted(tasks, key=lambda t: (positions[t["id"]]["x"], positions[t["id"]]["y"]))
    first_task = ordered[0]["id"]
    xs = sorted({positions[t["id"]]["x"] for t in tasks})
    parallel_col = sorted(
        [t for t in tasks if positions[t["id"]]["x"] == xs[1]],
        key=lambda t: positions[t["id"]]["y"],
    ) if len(xs) > 1 else [ordered[-1]]
    parallel_top = parallel_col[0]["id"]
    parallel_bottom = parallel_col[-1]["id"]
    tool_span = next((s for s in payload["spans"] if s["kind"] == "tool" and s.get("status") == "ok"), None)
    if tool_span is None:
        raise SystemExit("no ok-status tool span in payload; refusing to record a thin run")
    tool_key = tool_span["key"]

    def node(task_id):
        locator = page.locator('.dag-node[data-task-id="%s"]' % task_id)
        assert locator.count() == 1, "expected exactly one node for %s" % task_id
        return locator

    def click_node(task_id):
        node(task_id).click()
        page.mouse.move(*NEUTRAL)

    def wheel_anchor():
        top_box = node(parallel_top).bounding_box()
        bottom_box = node(parallel_bottom).bounding_box()
        return (
            (top_box["x"] + top_box["width"] / 2 + bottom_box["x"] + bottom_box["width"] / 2) / 2,
            (top_box["y"] + top_box["height"] / 2 + bottom_box["y"] + bottom_box["height"] / 2) / 2,
        )

    scroll_plan = {}

    def begin_scroll(start_frame, end_frame):
        start = page.evaluate("document.getElementById('waterfall').scrollTop")
        target = page.evaluate(
            """(key) => {
              const container = document.getElementById('waterfall');
              const row = document.querySelector('.wf-row[data-span-key="' + CSS.escape(key) + '"]');
              if (!row) return container.scrollTop;
              const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
              const ideal = offset - container.clientHeight * 0.55;
              return Math.max(0, Math.min(ideal, container.scrollHeight - container.clientHeight));
            }""",
            tool_key,
        )
        scroll_plan.update(start=start, target=target, start_frame=start_frame, end_frame=end_frame)

    def apply_scroll(frame):
        t = (frame - scroll_plan["start_frame"]) / (scroll_plan["end_frame"] - scroll_plan["start_frame"])
        value = scroll_plan["start"] + (scroll_plan["target"] - scroll_plan["start"]) * smoothstep(t)
        page.evaluate("(v) => { document.getElementById('waterfall').scrollTop = v; }", value)

    def click_tool_row():
        row = page.locator('.wf-row[data-span-key="%s"]' % tool_key)
        assert row.count() == 1, "expected exactly one waterfall row for the tool span"
        row.locator(".wf-select").click()
        page.mouse.move(*NEUTRAL)

    # Establish loop state S0 before the first frame.
    click_node(first_task)
    flush()

    ZOOM_START, ZOOM_END = frame_at(1.6), frame_at(2.6)
    SCROLL_START, SCROLL_END = frame_at(4.7), frame_at(6.2)

    for frame in range(TOTAL):
        if frame == frame_at(0.9):
            click_node(parallel_top)
        elif ZOOM_START <= frame <= ZOOM_END:
            if frame == ZOOM_START:
                page.mouse.move(*wheel_anchor())
            page.mouse.wheel(0, -25)
        elif frame == frame_at(2.75):
            click_node(parallel_bottom)
        elif frame == frame_at(4.0):
            page.click("#waterfallTab")
            flush()
            page.mouse.move(*NEUTRAL)
        elif frame == SCROLL_START:
            begin_scroll(SCROLL_START, SCROLL_END)
            apply_scroll(frame)
        elif SCROLL_START < frame <= SCROLL_END:
            apply_scroll(frame)
        elif frame == frame_at(6.5):
            click_tool_row()
        elif frame == frame_at(7.5):
            page.click("#dagTab")
            flush()
            page.mouse.move(*NEUTRAL)
        elif frame == frame_at(8.0):
            click_node(first_task)

        page.screenshot(path=str(frames_root / ("frame_%04d.png" % (frame + 1))))
        if (frame + 1) % fps == 0:
            print("captured %d/%d frames" % (frame + 1, TOTAL), file=sys.stderr)

    browser.close()
`

function renderFrames() {
  rmSync(FRAMES_DIR, { recursive: true, force: true })
  mkdirSync(FRAMES_DIR, { recursive: true })
  run('python3', ['-c', captureScript, INPUT_HTML, FRAMES_DIR, String(WIDTH), String(HEIGHT), String(FPS)])

  const captured = readdirSync(FRAMES_DIR).filter((name) => name.endsWith('.png')).length
  if (captured !== FRAME_COUNT) {
    throw new Error(`expected ${FRAME_COUNT} frames, captured ${captured}`)
  }

  const first = readFileSync(join(FRAMES_DIR, 'frame_0001.png'))
  const last = readFileSync(join(FRAMES_DIR, `frame_${String(FRAME_COUNT).padStart(4, '0')}.png`))
  if (!first.equals(last)) {
    console.warn('warning: first and last frames differ — the loop seam will be visible')
  } else {
    console.log('loop seam check: first and last frames are byte-identical')
  }
}

function encodeOutputs() {
  const framePattern = join(FRAMES_DIR, 'frame_%04d.png')

  run('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-start_number', '1',
    '-i', framePattern,
    '-frames:v', String(FRAME_COUNT),
    '-filter_complex',
    '[0:v]split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0',
    OUTPUT_GIF,
  ])

  run('ffmpeg', [
    '-y',
    '-framerate', String(FPS),
    '-start_number', '1',
    '-i', framePattern,
    '-frames:v', String(FRAME_COUNT),
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-movflags', '+faststart',
    OUTPUT_MP4,
  ])

  if (statSync(OUTPUT_GIF).size > README_GIF_LIMIT_BYTES) {
    run('ffmpeg', [
      '-y',
      '-framerate', String(FPS),
      '-start_number', '1',
      '-i', framePattern,
      '-frames:v', String(FRAME_COUNT),
      '-filter_complex',
      '[0:v]scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0',
      OUTPUT_GIF_1200,
    ])
  }
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
    : `${(bytes / 1024).toFixed(0)} KiB`
}

function printSummary() {
  console.log('')
  console.log('Generated README hero animation:')
  console.log(`- Source: ${INPUT_HTML} (${WIDTH}x${HEIGHT} viewport)`)
  console.log(`- Duration: ${DURATION_SECONDS}s at ${FPS} fps (${FRAME_COUNT} frames)`)
  for (const output of [OUTPUT_GIF, OUTPUT_MP4, OUTPUT_GIF_1200].filter(existsSync)) {
    console.log(`- ${output}: ${formatBytes(statSync(output).size)}`)
  }
}

function main() {
  if (!existsSync(INPUT_HTML)) {
    throw new Error(`Missing viewer snapshot: ${INPUT_HTML} — run capture-hero-run.mts first`)
  }
  renderFrames()
  encodeOutputs()
  printSummary()
}

main()
