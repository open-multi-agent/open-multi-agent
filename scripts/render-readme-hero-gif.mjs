#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const BRAND_DIR = join(ROOT, '.github', 'brand')
const SOURCE_PNG = join(BRAND_DIR, 'demo-dashboard-hero-original.png')
const WORK_DIR = join(BRAND_DIR, 'frames', 'readme-hero-gif')
const FRAMES_DIR = join(WORK_DIR, 'screenshots')
const HTML_PATH = join(WORK_DIR, 'readme-hero-overlay.html')

const OUTPUT_GIF = join(BRAND_DIR, 'demo-dashboard-hero.gif')
const OUTPUT_GIF_1200 = join(BRAND_DIR, 'demo-dashboard-hero-1200.gif')
const OUTPUT_MP4 = join(BRAND_DIR, 'demo-dashboard-hero.mp4')

const WIDTH = 1600
const HEIGHT = 760
const FPS = 12
const DURATION_SECONDS = 7
const FRAME_COUNT = FPS * DURATION_SECONDS
const README_GIF_LIMIT_BYTES = 8 * 1024 * 1024

function readPngSize(path) {
  const buf = readFileSync(path)
  const signature = '89504e470d0a1a0a'
  if (buf.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${path} is not a PNG file`)
  }

  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

function run(command, args) {
  const printable = [command, ...args].map((arg) => {
    if (/^[A-Za-z0-9_./:=+,-]+$/.test(arg)) return arg
    return JSON.stringify(arg)
  }).join(' ')
  console.log(`$ ${printable}`)

  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
}

function metricPath(file) {
  return file.replace(`${ROOT}/`, '')
}

function writeOverlayHtml() {
  const baseUrl = pathToFileURL(SOURCE_PNG).href
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${WIDTH}, initial-scale=1">
  <style>
    html,
    body {
      margin: 0;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      overflow: hidden;
      background: #0b1425;
    }

    .hero {
      position: relative;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      overflow: hidden;
      background: #0b1425;
    }

    .hero img,
    .hero svg {
      position: absolute;
      inset: 0;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      display: block;
    }

    text {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      dominant-baseline: alphabetic;
    }
  </style>
</head>
<body>
  <div class="hero">
    <img src="${baseUrl}" width="${WIDTH}" height="${HEIGHT}" alt="">
    <svg id="overlay" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" aria-hidden="true">
      <defs>
        <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.4" result="blur"></feGaussianBlur>
          <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.95  0 0 0 0 0.82  0 0 0 0.34 0" result="glow"></feColorMatrix>
          <feMerge>
            <feMergeNode in="glow"></feMergeNode>
            <feMergeNode in="SourceGraphic"></feMergeNode>
          </feMerge>
        </filter>
      </defs>

      <g id="active-traces" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path id="trace-0" data-start="0.070" data-end="0.165" pathLength="1" d="M 299 172 C 329 172 347 172 376 172"></path>
        <path id="trace-1" data-start="0.155" data-end="0.255" pathLength="1" d="M 299 178 C 350 182 327 339 376 339"></path>
        <path id="trace-2" data-start="0.230" data-end="0.350" pathLength="1" d="M 299 183 C 346 188 328 516 376 516"></path>
        <path id="trace-3" data-start="0.315" data-end="0.425" pathLength="1" d="M 575 172 C 612 172 615 172 651 172"></path>
        <path id="trace-4" data-start="0.390" data-end="0.500" pathLength="1" d="M 575 336 C 615 336 610 341 651 341"></path>
        <path id="trace-5" data-start="0.465" data-end="0.590" pathLength="1" d="M 575 329 C 635 306 594 216 651 188"></path>
        <path id="trace-6" data-start="0.545" data-end="0.670" pathLength="1" d="M 849 172 C 889 172 886 172 925 172"></path>
        <path id="trace-7" data-start="0.625" data-end="0.755" pathLength="1" d="M 849 186 C 897 188 878 338 925 338"></path>
        <path id="trace-8" data-start="0.690" data-end="0.805" pathLength="1" d="M 849 341 C 887 341 888 341 925 341"></path>
        <path id="trace-9" data-start="0.735" data-end="0.850" pathLength="1" d="M 575 516 C 715 487 798 410 925 341"></path>
      </g>

      <g id="node-highlights">
        <rect data-peak="0.200" x="101" y="116" width="199" height="117"></rect>
        <rect data-peak="0.335" x="376" y="116" width="199" height="133"></rect>
        <rect data-peak="0.355" x="376" y="283" width="199" height="117"></rect>
        <rect data-peak="0.375" x="376" y="450" width="199" height="132"></rect>
        <rect data-peak="0.545" x="651" y="116" width="198" height="132"></rect>
        <rect data-peak="0.565" x="651" y="283" width="198" height="117"></rect>
        <rect data-peak="0.720" x="925" y="116" width="199" height="132"></rect>
        <rect data-peak="0.850" x="925" y="283" width="199" height="117"></rect>
      </g>

      <g id="status-dots">
        <circle data-peak="0.080" cx="280" cy="139" r="5"></circle>
        <circle data-peak="0.180" cx="555" cy="139" r="5"></circle>
        <circle data-peak="0.290" cx="555" cy="306" r="5"></circle>
        <circle data-peak="0.385" cx="555" cy="473" r="5"></circle>
        <circle data-peak="0.495" cx="830" cy="139" r="5"></circle>
        <circle data-peak="0.600" cx="830" cy="306" r="5"></circle>
        <circle data-peak="0.715" cx="1105" cy="139" r="5"></circle>
        <circle data-peak="0.805" cx="1105" cy="306" r="5"></circle>
      </g>

      <g id="node-state-overlays">
        <g class="node-state" data-start="0.145" data-end="0.240" data-duration="1.8s" data-role="COORDINATOR" data-role-width="62">
          <rect class="state-strip" x="100" y="116" width="3" height="117"></rect>
          <rect class="icon-cover" x="270" y="129" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(280 139)"></g>
          <rect class="status-cover" x="114" y="187" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="114" y="198" font-size="10"></text>
          <rect class="chip-cover" x="114" y="206" width="132" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(114 207)"></g>
        </g>
        <g class="node-state" data-start="0.255" data-end="0.420" data-duration="3.6s" data-role="PROVIDER-AGENT" data-role-width="74">
          <rect class="state-strip" x="374" y="116" width="3" height="133"></rect>
          <rect class="icon-cover" x="545" y="129" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(555 139)"></g>
          <rect class="status-cover" x="389" y="191" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="389" y="202" font-size="10"></text>
          <rect class="chip-cover" x="389" y="221" width="144" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(389 222)"></g>
        </g>
        <g class="node-state" data-start="0.280" data-end="0.430" data-duration="4.2s" data-role="INTEGRATION-AGENT" data-role-width="84">
          <rect class="state-strip" x="374" y="283" width="3" height="117"></rect>
          <rect class="icon-cover" x="545" y="296" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(555 306)"></g>
          <rect class="status-cover" x="389" y="348" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="389" y="359" font-size="10"></text>
          <rect class="chip-cover" x="389" y="373" width="152" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(389 374)"></g>
        </g>
        <g class="node-state" data-start="0.300" data-end="0.450" data-duration="3.0s" data-role="MEMORY-AGENT" data-role-width="66">
          <rect class="state-strip" x="374" y="450" width="3" height="132"></rect>
          <rect class="icon-cover" x="545" y="463" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(555 473)"></g>
          <rect class="status-cover" x="389" y="527" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="389" y="538" font-size="10"></text>
          <rect class="chip-cover" x="389" y="556" width="138" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(389 557)"></g>
        </g>
        <g class="node-state" data-start="0.470" data-end="0.620" data-duration="5.9s" data-role="DEVELOPER" data-role-width="54">
          <rect class="state-strip" x="649" y="116" width="3" height="132"></rect>
          <rect class="icon-cover" x="820" y="129" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(830 139)"></g>
          <rect class="status-cover" x="664" y="191" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="664" y="202" font-size="10"></text>
          <rect class="chip-cover" x="664" y="221" width="124" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(664 222)"></g>
        </g>
        <g class="node-state" data-start="0.500" data-end="0.630" data-duration="2.6s" data-role="SCHEMA-AGENT" data-role-width="68">
          <rect class="state-strip" x="649" y="283" width="3" height="117"></rect>
          <rect class="icon-cover" x="820" y="296" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(830 306)"></g>
          <rect class="status-cover" x="664" y="348" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="664" y="359" font-size="10"></text>
          <rect class="chip-cover" x="664" y="373" width="140" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(664 374)"></g>
        </g>
        <g class="node-state" data-start="0.660" data-end="0.780" data-duration="4.1s" data-role="REVIEWER" data-role-width="50">
          <rect class="state-strip" x="923" y="116" width="3" height="132"></rect>
          <rect class="icon-cover" x="1095" y="129" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(1105 139)"></g>
          <rect class="status-cover" x="939" y="191" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="939" y="202" font-size="10"></text>
          <rect class="chip-cover" x="939" y="221" width="120" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(939 222)"></g>
        </g>
        <g class="node-state" data-start="0.800" data-end="0.900" data-duration="3.4s" data-role="OBSERVABILITY-AGENT" data-role-width="88">
          <rect class="state-strip" x="923" y="283" width="3" height="117"></rect>
          <rect class="icon-cover" x="1095" y="296" width="20" height="20" fill="#020504"></rect>
          <g class="state-icon" transform="translate(1105 306)"></g>
          <rect class="status-cover" x="939" y="348" width="147" height="15" fill="#020504"></rect>
          <text class="status-text" x="939" y="359" font-size="10"></text>
          <rect class="chip-cover" x="939" y="373" width="158" height="17" fill="#020504"></rect>
          <g class="chip-row" transform="translate(939 374)"></g>
        </g>
      </g>

      <g id="panel-focus-overlay">
        <rect x="1173" y="247" width="371" height="60" fill="#101a32"></rect>
        <text id="panel-assignee" x="1186" y="274" fill="#e9efff" font-size="15" font-weight="700">observability-agent</text>
        <text id="panel-state" x="1186" y="291" fill="#f5d94e" font-size="10" font-weight="700">STATE: STABLE</text>
      </g>

      <g id="execution-time-overlay">
        <rect x="1177" y="355" width="145" height="33" fill="#101a32"></rect>
        <rect x="1370" y="355" width="145" height="33" fill="#101a32"></rect>
        <text id="panel-start-date" x="1181" y="368" fill="#dce5f7" font-size="12" font-weight="600">2026-04-02</text>
        <text id="panel-start-time" x="1181" y="384" fill="#dce5f7" font-size="12" font-weight="600">10:24:13.200Z</text>
        <text id="panel-end-date" x="1375" y="368" fill="#b9c2d4" font-size="12" font-weight="600">2026-04-02</text>
        <text id="panel-end-time" x="1375" y="384" fill="#b9c2d4" font-size="12" font-weight="600">10:24:16.600Z</text>
      </g>

      <g id="metric-overlay">
        <rect x="1486" y="457" width="47" height="18" fill="#14213a"></rect>
        <rect x="1502" y="480" width="31" height="18" fill="#14213a"></rect>
        <text id="prompt-tokens" x="1528" y="469" text-anchor="end" fill="#e9efff" font-size="13" font-weight="700">1,860</text>
        <text id="completion-tokens" x="1528" y="492" text-anchor="end" fill="#f5d94e" font-size="13" font-weight="700">740</text>

        <rect x="1188" y="504" width="341" height="7" fill="#1e2c49" opacity="0.96"></rect>
        <rect id="token-bar" x="1188" y="505" width="244" height="4" fill="#79e9f2"></rect>
        <rect id="token-tail" x="1429" y="505" width="4" height="4" fill="#f4d75c"></rect>

        <rect x="1177" y="574" width="34" height="21" fill="#0f1d33" opacity="0.96"></rect>
        <text id="tool-call-count" x="1181" y="588" fill="#e9efff" font-size="15" font-weight="650">1</text>

        <rect x="1173" y="664" width="371" height="96" fill="#010308"></rect>
        <circle id="live-pulse" cx="1180" cy="683" r="3.5" fill="#a6ffbd" opacity="0.22"></circle>
        <text id="panel-log-1" x="1187" y="686" fill="#a6ffbd" font-size="9.5" font-weight="650">[SYSTEM] Task graph execution finished.</text>
        <text id="panel-log-2" x="1187" y="705" fill="#c8d1e2" font-size="9.5">[COORDINATOR] Plan task DAG from goal -> COMPLETED</text>
        <text id="panel-log-3" x="1187" y="724" fill="#c8d1e2" font-size="9.5">[PROVIDER-AGENT] Mix providers + local Ollama -> COMPLETED</text>
        <text id="panel-log-4" x="1187" y="743" fill="#c8d1e2" font-size="9.5">[OBSERVABILITY] Emit traces + dashboard -> COMPLETED</text>
        <rect id="terminal-cursor" x="1515" y="735" width="6" height="11" fill="#a6ffbd" opacity="0.0"></rect>
      </g>
    </svg>
  </div>

  <script>
    const traces = Array.from(document.querySelectorAll('#active-traces path'));
    const nodes = Array.from(document.querySelectorAll('#node-highlights rect'));
    const dots = Array.from(document.querySelectorAll('#status-dots circle'));
    const stateGroups = Array.from(document.querySelectorAll('.node-state'));
    const panelAssignee = document.getElementById('panel-assignee');
    const panelState = document.getElementById('panel-state');
    const panelStartDate = document.getElementById('panel-start-date');
    const panelStartTime = document.getElementById('panel-start-time');
    const panelEndDate = document.getElementById('panel-end-date');
    const panelEndTime = document.getElementById('panel-end-time');
    const panelLog1 = document.getElementById('panel-log-1');
    const panelLog2 = document.getElementById('panel-log-2');
    const panelLog3 = document.getElementById('panel-log-3');
    const panelLog4 = document.getElementById('panel-log-4');
    const promptTokens = document.getElementById('prompt-tokens');
    const completionTokens = document.getElementById('completion-tokens');
    const tokenBar = document.getElementById('token-bar');
    const tokenTail = document.getElementById('token-tail');
    const toolCallCount = document.getElementById('tool-call-count');
    const livePulse = document.getElementById('live-pulse');
    const terminalCursor = document.getElementById('terminal-cursor');

    const taskDetails = [
      {
        assignee: 'coordinator',
        title: 'Plan task DAG from goal',
        logTitle: 'Plan task DAG from goal',
        start: ['2026-04-02', '10:24:01.200Z'],
        end: ['2026-04-02', '10:24:03.000Z'],
        prompt: 920,
        completion: 380,
        toolCalls: 0,
      },
      {
        assignee: 'provider-agent',
        title: 'Mix Anthropic, OpenAI, and local Ollama',
        logTitle: 'Mix providers + local Ollama',
        start: ['2026-04-02', '10:24:03.100Z'],
        end: ['2026-04-02', '10:24:06.700Z'],
        prompt: 1260,
        completion: 610,
        toolCalls: 0,
      },
      {
        assignee: 'integration-agent',
        title: 'Connect MCP and built-in tools',
        logTitle: 'Connect MCP + built-in tools',
        start: ['2026-04-02', '10:24:03.100Z'],
        end: ['2026-04-02', '10:24:07.300Z'],
        prompt: 1420,
        completion: 760,
        toolCalls: 2,
      },
      {
        assignee: 'memory-agent',
        title: 'Apply token budget and context compaction',
        logTitle: 'Apply token budget + compaction',
        start: ['2026-04-02', '10:24:03.100Z'],
        end: ['2026-04-02', '10:24:06.100Z'],
        prompt: 1180,
        completion: 520,
        toolCalls: 0,
      },
      {
        assignee: 'developer',
        title: 'Implement API with bash and file edits',
        logTitle: 'Implement API + file edits',
        start: ['2026-04-02', '10:24:07.300Z'],
        end: ['2026-04-02', '10:24:13.200Z'],
        prompt: 2140,
        completion: 1360,
        toolCalls: 3,
      },
      {
        assignee: 'schema-agent',
        title: 'Validate Zod structured output',
        logTitle: 'Validate Zod output',
        start: ['2026-04-02', '10:24:07.600Z'],
        end: ['2026-04-02', '10:24:10.200Z'],
        prompt: 1540,
        completion: 680,
        toolCalls: 1,
      },
      {
        assignee: 'reviewer',
        title: 'Review security and retry edge cases',
        logTitle: 'Review security + retry cases',
        start: ['2026-04-02', '10:24:12.500Z'],
        end: ['2026-04-02', '10:24:16.600Z'],
        prompt: 1980,
        completion: 920,
        toolCalls: 2,
      },
      {
        assignee: 'observability-agent',
        title: 'Emit traces and render dashboard',
        logTitle: 'Emit traces + dashboard',
        start: ['2026-04-02', '10:24:13.200Z'],
        end: ['2026-04-02', '10:24:16.600Z'],
        prompt: 1860,
        completion: 740,
        toolCalls: 1,
      },
    ];

    function clamp(value, min = 0, max = 1) {
      return Math.min(max, Math.max(min, value));
    }

    function ease(value) {
      const v = clamp(value);
      return v * v * (3 - 2 * v);
    }

    function pulseAt(phase, peak, width) {
      const distance = Math.abs(phase - peak);
      return ease(1 - clamp(distance / width));
    }

    function formatNumber(value) {
      return Math.round(value).toLocaleString('en-US');
    }

    function upperAssignee(value) {
      return String(value).toUpperCase();
    }

    function stateForNode(index, phase) {
      if (phase < 0.080 || phase >= 0.915) return 'done';
      if (phase < 0.135) return 'pending';

      const group = stateGroups[index];
      const start = Number(group.dataset.start);
      const end = Number(group.dataset.end);
      if (phase < start) return 'pending';
      if (phase <= end) return 'running';
      return 'done';
    }

    function nodeProgress(index, phase) {
      const group = stateGroups[index];
      const start = Number(group.dataset.start);
      const end = Number(group.dataset.end);
      return clamp((phase - start) / (end - start));
    }

    function focusedNodeIndex(phase) {
      if (phase < 0.080 || phase >= 0.915) return taskDetails.length - 1;
      if (phase < 0.135) return 0;

      const running = [];
      for (let i = 0; i < taskDetails.length; i++) {
        if (stateForNode(i, phase) === 'running') running.push(i);
      }

      if (running.length > 0) {
        return running.reduce((best, index) => {
          const group = stateGroups[index];
          const midpoint = (Number(group.dataset.start) + Number(group.dataset.end)) / 2;
          const bestGroup = stateGroups[best];
          const bestMidpoint = (Number(bestGroup.dataset.start) + Number(bestGroup.dataset.end)) / 2;
          return Math.abs(phase - midpoint) < Math.abs(phase - bestMidpoint) ? index : best;
        }, running[0]);
      }

      let latest = 0;
      for (let i = 0; i < taskDetails.length; i++) {
        const group = stateGroups[i];
        if (phase > Number(group.dataset.end)) latest = i;
      }
      return latest;
    }

    function cumulativeMetrics(phase) {
      if (phase < 0.080 || phase >= 0.915) {
        return taskDetails.reduce((sum, task) => ({
          prompt: sum.prompt + task.prompt,
          completion: sum.completion + task.completion,
          toolCalls: sum.toolCalls + task.toolCalls,
        }), { prompt: 0, completion: 0, toolCalls: 0 });
      }

      return taskDetails.reduce((sum, task, index) => {
        const nodeState = stateForNode(index, phase);
        if (nodeState === 'pending') return sum;

        if (nodeState === 'done') {
          return {
            prompt: sum.prompt + task.prompt,
            completion: sum.completion + task.completion,
            toolCalls: sum.toolCalls + task.toolCalls,
          };
        }

        const progress = nodeProgress(index, phase);
        return {
          prompt: sum.prompt + Math.round(task.prompt * progress),
          completion: sum.completion + Math.round(task.completion * Math.pow(progress, 1.15)),
          toolCalls: sum.toolCalls + Math.min(task.toolCalls, Math.floor(task.toolCalls * progress)),
        };
      }, { prompt: 0, completion: 0, toolCalls: 0 });
    }

    function stateColor(state) {
      if (state === 'running') return '#f5d94e';
      if (state === 'done') return '#8af7d1';
      return '#60708a';
    }

    function stateTextColor(state) {
      if (state === 'running') return '#f5d94e';
      if (state === 'done') return '#c8d1e2';
      return '#8b96aa';
    }

    function renderIcon(container, state, phase) {
      if (state === 'done') {
        container.innerHTML = '<circle cx="0" cy="0" r="5.1" fill="none" stroke="#b9ffc8" stroke-width="1.4"></circle><path d="M -2.6 0.1 L -0.6 2.1 L 3 -2.1" fill="none" stroke="#b9ffc8" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>';
        return;
      }

      if (state === 'running') {
        const angle = Math.round((phase * 720) % 360);
        container.innerHTML = '<circle cx="0" cy="0" r="5.1" fill="none" stroke="#f5d94e" stroke-opacity="0.28" stroke-width="1.4"></circle><path d="M 0 -5.1 A 5.1 5.1 0 0 1 5.1 0" fill="none" stroke="#f5d94e" stroke-width="1.6" stroke-linecap="round" transform="rotate(' + angle + ')"></path>';
        return;
      }

      container.innerHTML = '<circle cx="0" cy="0" r="4.8" fill="none" stroke="#6f7b91" stroke-opacity="0.62" stroke-width="1.2"></circle>';
    }

    function renderChips(container, role, roleWidth, state) {
      const stateChip = state === 'done' ? 'STABLE' : state === 'running' ? 'ACTIVE' : 'WAITING';
      const stateWidth = state === 'running' ? 42 : state === 'pending' ? 48 : 38;
      const stateX = roleWidth + 7;
      container.innerHTML =
        '<rect x="0" y="0" width="' + roleWidth + '" height="13" fill="#172540"></rect>' +
        '<text x="6" y="9" fill="#aab7cf" font-size="7.5">' + role + '</text>' +
        '<rect x="' + stateX + '" y="0" width="' + stateWidth + '" height="13" fill="#172540"></rect>' +
        '<text x="' + (stateX + 6) + '" y="9" fill="' + stateTextColor(state) + '" font-size="7.5">' + stateChip + '</text>';
    }

    function updatePanel(phase) {
      const index = focusedNodeIndex(phase);
      const task = taskDetails[index];
      const state = stateForNode(index, phase);
      const runMetrics = cumulativeMetrics(phase);
      const prompt = runMetrics.prompt;
      const completion = runMetrics.completion;
      const visibleToolCalls = runMetrics.toolCalls;
      const total = prompt + completion;
      const tokenRatio = total > 0 ? prompt / total : 0;
      const barWidth = Math.round(341 * tokenRatio);
      const panelChip = state === 'done' ? 'STABLE' : state === 'running' ? 'ACTIVE' : 'WAITING';
      const statusWord = state === 'done' ? 'COMPLETED' : state === 'running' ? 'RUNNING' : 'WAITING';

      panelAssignee.textContent = task.assignee;
      panelState.textContent = 'STATE: ' + panelChip;
      panelState.setAttribute('fill', state === 'running' ? '#f5d94e' : state === 'done' ? '#f5d94e' : '#8b96aa');

      if (state === 'pending') {
        panelStartDate.textContent = '-';
        panelStartTime.textContent = '';
        panelEndDate.textContent = '-';
        panelEndTime.textContent = '';
      } else {
        panelStartDate.textContent = task.start[0];
        panelStartTime.textContent = task.start[1];
        if (state === 'running') {
          panelEndDate.textContent = '-';
          panelEndTime.textContent = '';
        } else {
          panelEndDate.textContent = task.end[0];
          panelEndTime.textContent = task.end[1];
        }
      }

      promptTokens.textContent = formatNumber(prompt);
      completionTokens.textContent = formatNumber(completion);
      tokenBar.setAttribute('width', String(barWidth));
      tokenBar.setAttribute('opacity', total > 0 ? '1' : '0.18');
      tokenTail.setAttribute('x', String(1188 + barWidth + 1));
      tokenTail.setAttribute('opacity', completion > 0 ? '1' : '0');
      toolCallCount.textContent = String(visibleToolCalls);
      toolCallCount.setAttribute('fill', state === 'running' ? '#f5d94e' : '#e9efff');

      const allDone = phase < 0.080 || phase >= 0.915;
      if (allDone) {
        panelLog1.textContent = '[SYSTEM] Task graph execution finished.';
        panelLog2.textContent = '[COORDINATOR] Plan task DAG from goal -> COMPLETED';
        panelLog3.textContent = '[PROVIDER-AGENT] Mix providers + local Ollama -> COMPLETED';
        panelLog4.textContent = '[OBSERVABILITY] Emit traces + dashboard -> COMPLETED';
      } else {
        panelLog1.textContent = state === 'running'
          ? '[SYSTEM] Task graph execution in progress.'
          : '[SYSTEM] Task graph execution queued.';
        panelLog2.textContent = '[' + upperAssignee(task.assignee) + '] ' + task.logTitle + ' -> ' + statusWord;
        panelLog3.textContent = '[RUN METRICS] prompt ' + formatNumber(prompt) + ', completion ' + formatNumber(completion);
        panelLog4.textContent = '[TOOLS] total calls ' + visibleToolCalls + ' / trace span updated';
      }
    }

    window.setHeroFrame = function setHeroFrame(frameIndex, totalFrames) {
      const phase = frameIndex / totalFrames;
      for (const [index, node] of nodes.entries()) {
        const state = stateForNode(index, phase);
        const p = pulseAt(phase, Number(node.dataset.peak), 0.070);
        const color = stateColor(state);
        const baseFill = state === 'pending' ? 0.006 : 0.014;
        const pulseFill = state === 'running' ? 0.075 : state === 'done' ? 0.045 : 0.014;
        const baseStroke = state === 'pending' ? 0.08 : 0.12;
        const pulseStroke = state === 'running' ? 0.62 : state === 'done' ? 0.42 : 0.12;
        node.setAttribute('fill', color);
        node.setAttribute('fill-opacity', String(baseFill + p * pulseFill));
        node.setAttribute('stroke', color);
        node.setAttribute('stroke-width', String(1 + p * 1.2));
        node.setAttribute('stroke-opacity', String(baseStroke + p * pulseStroke));
        node.setAttribute('filter', state === 'done' && p > 0.28 ? 'url(#softGlow)' : '');
      }

      for (const [index, dot] of dots.entries()) {
        const state = stateForNode(index, phase);
        const p = pulseAt(phase, Number(dot.dataset.peak), 0.060);
        dot.setAttribute('fill', stateColor(state));
        dot.setAttribute('opacity', String(state === 'running' ? 0.10 + p * 0.28 : 0));
      }

      for (const [index, group] of stateGroups.entries()) {
        const state = stateForNode(index, phase);
        const color = stateColor(state);
        const strip = group.querySelector('.state-strip');
        const statusText = group.querySelector('.status-text');
        const icon = group.querySelector('.state-icon');
        const chipRow = group.querySelector('.chip-row');

        strip.setAttribute('fill', color);
        strip.setAttribute('opacity', state === 'pending' ? '0.42' : state === 'running' ? '0.88' : '1');

        const label = state === 'done'
          ? 'STATUS: DONE (' + group.dataset.duration + ')'
          : state === 'running'
            ? 'STATUS: RUNNING'
            : 'STATUS: WAITING';
        statusText.textContent = label;
        statusText.setAttribute('fill', stateTextColor(state));
        statusText.setAttribute('font-weight', state === 'running' ? '700' : '500');

        renderIcon(icon, state, phase);
        renderChips(chipRow, group.dataset.role, Number(group.dataset.roleWidth), state);
      }

      for (const trace of traces) {
        const start = Number(trace.dataset.start);
        const end = Number(trace.dataset.end);
        const progress = clamp((phase - start) / (end - start));
        const active = phase >= start && phase <= end;
        const opacity = active ? Math.sin(progress * Math.PI) * 0.62 : 0.035;
        trace.setAttribute('stroke', '#8eeeff');
        trace.setAttribute('stroke-width', active ? '2.1' : '1.1');
        trace.setAttribute('stroke-opacity', String(opacity));
        trace.setAttribute('stroke-dasharray', active ? '0.115 0.885' : '0.01 0.99');
        trace.setAttribute('stroke-dashoffset', String(1 - progress));
      }

      updatePanel(phase);

      const live = 0.22 + 0.42 * pulseAt(phase, 0.86, 0.11);
      livePulse.setAttribute('opacity', String(live));
      terminalCursor.setAttribute('opacity', String((Math.sin(Math.PI * 2 * phase * 7) > 0 ? 0.55 : 0.08) * (0.6 + live)));
    };

    window.setHeroFrame(0, ${FRAME_COUNT});
    window.heroReady = true;
  </script>
</body>
</html>`

  writeFileSync(HTML_PATH, html, 'utf8')
}

const captureScript = String.raw`
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

html_path = Path(sys.argv[1]).resolve()
frames_dir = Path(sys.argv[2]).resolve()
frame_count = int(sys.argv[3])
width = int(sys.argv[4])
height = int(sys.argv[5])

frames_dir.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(
        viewport={"width": width, "height": height},
        device_scale_factor=1,
        color_scheme="dark",
    )
    page.goto(html_path.as_uri(), wait_until="load", timeout=30000)
    page.wait_for_function("() => window.heroReady === true", timeout=30000)

    for i in range(frame_count):
        page.evaluate("(args) => window.setHeroFrame(args.i, args.total)", {"i": i, "total": frame_count})
        out = frames_dir / f"frame_{i + 1:04d}.png"
        page.screenshot(
            path=str(out),
            type="png",
            clip={"x": 0, "y": 0, "width": width, "height": height},
        )

    browser.close()
`

function renderFrames() {
  run('python3', [
    '-c',
    captureScript,
    HTML_PATH,
    FRAMES_DIR,
    String(FRAME_COUNT),
    String(WIDTH),
    String(HEIGHT),
  ])
}

function encodeOutputs() {
  const framePattern = join(FRAMES_DIR, 'frame_%04d.png')

  run('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-start_number',
    '1',
    '-i',
    framePattern,
    '-frames:v',
    String(FRAME_COUNT),
    '-filter_complex',
    '[0:v]split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop',
    '0',
    OUTPUT_GIF,
  ])

  run('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-start_number',
    '1',
    '-i',
    framePattern,
    '-frames:v',
    String(FRAME_COUNT),
    '-vf',
    'format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-movflags',
    '+faststart',
    OUTPUT_MP4,
  ])

  if (statSync(OUTPUT_GIF).size > README_GIF_LIMIT_BYTES) {
    run('ffmpeg', [
      '-y',
      '-framerate',
      String(FPS),
      '-start_number',
      '1',
      '-i',
      framePattern,
      '-frames:v',
      String(FRAME_COUNT),
      '-filter_complex',
      '[0:v]scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop',
      '0',
      OUTPUT_GIF_1200,
    ])
  }
}

function printSummary() {
  const outputs = [OUTPUT_GIF, OUTPUT_MP4, OUTPUT_GIF_1200].filter(existsSync)
  console.log('')
  console.log('Generated README hero animation:')
  console.log(`- Source: ${metricPath(SOURCE_PNG)} (${WIDTH}x${HEIGHT})`)
  console.log(`- Duration: ${DURATION_SECONDS}s at ${FPS} fps (${FRAME_COUNT} frames)`)
  for (const output of outputs) {
    console.log(`- ${metricPath(output)}: ${formatBytes(statSync(output).size)}`)
  }
  console.log(`- Render cache: ${metricPath(WORK_DIR)}`)
}

function main() {
  if (!existsSync(SOURCE_PNG)) {
    throw new Error(`Missing source image: ${SOURCE_PNG}`)
  }

  const size = readPngSize(SOURCE_PNG)
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    throw new Error(`Expected ${WIDTH}x${HEIGHT}, got ${size.width}x${size.height}`)
  }

  mkdirSync(FRAMES_DIR, { recursive: true })
  writeOverlayHtml()
  renderFrames()
  encodeOutputs()
  printSummary()
}

main()
