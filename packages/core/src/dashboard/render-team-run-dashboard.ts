/**
 * Pure HTML renderer for the post-run team task DAG dashboard (no filesystem or network I/O).
 */

import type { TeamRunResult } from '../types.js'
import { layoutTasks } from './layout-tasks.js'
import { redactSensitiveObject } from '../utils/redaction.js'

/**
 * Escape serialized JSON so it can be embedded in HTML without closing a {@code <script>} tag.
 * The HTML tokenizer ends a script on {@code </script>} even for {@code type="application/json"}.
 */
export function escapeJsonForHtmlScript(json: string): string {
  return json.replace(/<\/script/gi, '<\\/script')
}

export function renderTeamRunDashboard(result: TeamRunResult): string {
  const generatedAt = new Date().toISOString()
  const tasks = result.tasks ?? []
  const layout = layoutTasks(tasks)
  const serializedPositions = Object.fromEntries(layout.positions)
  const payload = {
    generatedAt,
    goal: result.goal ?? '',
    tasks,
    layout: {
      positions: serializedPositions,
      width: layout.width,
      height: layout.height,
      nodeW: layout.nodeW,
      nodeH: layout.nodeH,
    },
  }
  const dataJson = escapeJsonForHtmlScript(JSON.stringify(redactSensitiveObject(payload)))

  return `<!DOCTYPE html>
<html class="dark" lang="en">
<head>
    <meta charset="utf-8" />
    <meta content="width=device-width, initial-scale=1.0" name="viewport" />
    <title>Open Multi Agent</title>
    <style>
        :root {
            --surface: #060e20;
            --surface-container: #0f1930;
            --surface-container-high: #141f38;
            --surface-container-low: #091328;
            --surface-container-lowest: #000000;
            --surface-variant: #192540;
            --on-surface: #dee5ff;
            --on-surface-variant: #a3aac4;
            --primary: #81ecff;
            --secondary: #fdc003;
            --tertiary: #b8ffbb;
            --error: #ff716c;
            --outline: #6d758c;
            --outline-variant: #40485d;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            background: var(--surface);
            color: var(--on-surface);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        p, h2, h3 { margin: 0; }
        main {
            display: flex;
            gap: 1.5rem;
            min-height: calc(100vh - 64px);
            padding: 2rem;
            position: relative;
            overflow: hidden;
        }
        #viewport {
            flex: 1;
            min-height: 600px;
            position: relative;
            overflow: hidden;
            cursor: grab;
        }
        #viewport.cursor-grabbing { cursor: grabbing; }
        #canvas {
            position: absolute;
            inset: 0;
            transform-origin: top left;
        }
        #edgesLayer {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
        }
        #detailsPanel {
            position: relative;
            width: min(400px, 100%);
            background: var(--surface-container-high);
            padding: 1.5rem;
            border-left: 1px solid rgba(64, 72, 93, 0.4);
            display: flex;
            flex-direction: column;
            gap: 2rem;
        }
        #closePanel {
            position: absolute;
            top: 1rem;
            right: 1rem;
            color: var(--on-surface-variant);
            background: transparent;
            border: 0;
            cursor: pointer;
        }
        #closePanel:hover { color: var(--primary); }
        #liveOutput {
            background: var(--surface-container-lowest);
            flex: 1;
            min-height: 160px;
            padding: 0.75rem;
            font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
            overflow-y: auto;
        }
        #selectedTokenRatio {
            height: 100%;
            width: 0;
            background: var(--primary);
        }
        .hidden { display: none !important; }
        .material-symbols-outlined {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 0.75rem;
            line-height: 1;
        }
        .grid-pattern {
            background-image: radial-gradient(circle, #40485d 1px, transparent 1px);
            background-size: 24px 24px;
        }
        .node-active-glow {
            box-shadow: 0 0 15px rgba(129, 236, 255, 0.15);
        }
        .node {
            position: absolute;
            width: 16rem;
            border-left: 2px solid var(--outline);
            padding: 1rem;
            cursor: pointer;
            overflow: hidden;
        }
        .node h3 {
            margin: 0.25rem 0;
            font-size: 0.875rem;
            font-weight: 700;
            overflow-wrap: anywhere;
        }
        .node span { display: inline-block; }
        .flex { display: flex; }
        .flex-1 { flex: 1; }
        .flex-col { flex-direction: column; }
        .grid { display: grid; }
        .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .justify-between { justify-content: space-between; }
        .items-start { align-items: flex-start; }
        .items-center { align-items: center; }
        .gap-1 { gap: 0.25rem; }
        .gap-2 { gap: 0.5rem; }
        .gap-4 { gap: 1rem; }
        .gap-8 { gap: 2rem; }
        .mb-1 { margin-bottom: 0.25rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mt-2 { margin-top: 0.5rem; }
        .p-2 { padding: 0.5rem; }
        .p-3 { padding: 0.75rem; }
        .p-4 { padding: 1rem; }
        .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
        .py-0\\.5 { padding-top: 0.125rem; padding-bottom: 0.125rem; }
        .w-full { width: 100%; }
        .h-1 { height: 0.25rem; }
        .text-xs { font-size: 0.75rem; }
        .text-sm { font-size: 0.875rem; }
        .text-lg { font-size: 1.125rem; }
        .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .font-bold { font-weight: 700; }
        .font-black { font-weight: 900; }
        .uppercase { text-transform: uppercase; }
        .tracking-widest { letter-spacing: 0.08em; }
        .bg-surface-container { background: var(--surface-container); }
        .bg-surface-container-low { background: var(--surface-container-low); }
        .bg-surface-container-lowest { background: var(--surface-container-lowest); }
        .bg-surface-variant { background: var(--surface-variant); }
        .text-primary { color: var(--primary); }
        .text-secondary { color: var(--secondary); }
        .text-tertiary { color: var(--tertiary); }
        .text-error { color: var(--error); }
        .text-outline { color: var(--outline); }
        .text-on-surface { color: var(--on-surface); }
        .text-on-surface-variant { color: var(--on-surface-variant); }
        .border-tertiary { border-color: var(--tertiary); }
        .border-error { border-color: var(--error); }
        .border-outline { border-color: var(--outline); }
        .border-secondary { border-color: var(--secondary); }
        .opacity-60 { opacity: 0.6; }
        .grayscale { filter: grayscale(1); }
        .space-y-1 > * + * { margin-top: 0.25rem; }
        .space-y-2 > * + * { margin-top: 0.5rem; }
        .space-y-6 > * + * { margin-top: 1.5rem; }
        .bg-gradient-to-b {
            position: fixed;
            left: 0;
            top: 0;
            width: 4px;
            height: 100vh;
            background: linear-gradient(to bottom, var(--primary), var(--secondary), var(--tertiary));
            opacity: 0.3;
            z-index: 60;
        }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 1023px) {
            main { flex-direction: column; padding: 1rem; }
            #detailsPanel { border-left: 0; border-top: 1px solid rgba(64, 72, 93, 0.4); }
        }
        @media (min-width: 1024px) {
            /* A class selector (.flex-col, specificity 0,1,0) outranks a bare main
               type selector (0,0,1), so this row override must also be class-level
               or it never wins and the details panel stays stacked below the canvas
               on desktop instead of becoming the right-hand sidebar. */
            main.flex-col { flex-direction: row; }
        }
    </style>
</head>
<body class="bg-surface text-on-surface font-body selection:bg-primary selection:text-on-primary">
    <main class="p-8 min-h-[calc(100vh-64px)] grid-pattern relative overflow-hidden flex flex-col lg:flex-row gap-6">
        <div id="viewport" class="flex-1 relative min-h-[600px] overflow-hidden cursor-grab">
            <div id="canvas" class="absolute inset-0 origin-top-left">
                <svg id="edgesLayer" class="absolute inset-0 w-full h-full pointer-events-none" xmlns="http://www.w3.org/2000/svg"></svg>
                <div id="nodesLayer"></div>
            </div>
        </div>
        <aside id="detailsPanel" class="hidden w-full lg:w-[400px] bg-surface-container-high p-6 flex flex-col gap-8 border-l border-outline-variant/10">
            <div>
                <h2 class="font-headline font-black text-lg tracking-widest mb-6 text-primary flex items-center gap-2">
                    <span class="material-symbols-outlined" data-icon="info">info</span>
                    NODE_DETAILS
                </h2>
                <button id="closePanel" class="absolute top-4 right-4 text-on-surface-variant hover:text-primary">
                    <span class="material-symbols-outlined">close</span>
                </button>
                <div class="space-y-6">
                    <div class="flex flex-col gap-2">
                        <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Goal</label>
                        <p id="goalText" class="text-xs bg-surface-container p-3 border-b border-outline-variant/20"></p>
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Assigned Agent</label>
                        <div class="flex items-center gap-4 bg-surface-container p-3">
                            <div>
                                <p id="selectedAssignee" class="text-sm font-bold text-on-surface">-</p>
                                <p id="selectedState" class="text-[10px] font-mono text-secondary">ACTIVE STATE: -</p>
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Execution Start</label>
                            <p id="selectedStart" class="text-xs font-mono bg-surface-container p-2 border-b border-outline-variant/20">-</p>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Execution End</label>
                            <p id="selectedEnd" class="text-xs font-mono bg-surface-container p-2 border-b border-outline-variant/20 text-on-surface-variant">-</p>
                        </div>
                    </div>
                    <div class="flex flex-col gap-1">
                        <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Token Breakdown</label>
                        <div class="space-y-2 bg-surface-container p-4">
                            <div class="flex justify-between text-xs font-mono">
                                <span class="text-on-surface-variant">PROMPT:</span>
                                <span id="selectedPromptTokens" class="text-on-surface">0</span>
                            </div>
                            <div class="flex justify-between text-xs font-mono">
                                <span class="text-on-surface-variant">COMPLETION:</span>
                                <span id="selectedCompletionTokens" class="text-on-surface text-secondary">0</span>
                            </div>
                            <div class="w-full h-1 bg-surface-variant mt-2">
                                <div id="selectedTokenRatio" class="bg-primary h-full w-0"></div>
                            </div>
                        </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <label class="text-[10px] font-headline uppercase tracking-widest text-on-surface-variant">Tool Calls</label>
                      <p id="selectedToolCalls" class="text-xs font-mono bg-surface-container p-2 border-b border-outline-variant/20">0</p>
                    </div>
                </div>
            </div>
            <div class="flex-1 flex flex-col min-h-[200px]">
                <h2 class="font-headline font-black text-[10px] tracking-widest mb-4 text-on-surface-variant">LIVE_AGENT_OUTPUT</h2>
                <div id="liveOutput" class="bg-surface-container-lowest flex-1 p-3 font-mono text-[10px] leading-relaxed overflow-y-auto space-y-1">
                </div>
            </div>
        </aside>
    </main>
    <div class="fixed left-0 top-0 w-1 h-screen bg-gradient-to-b from-primary via-secondary to-tertiary z-[60] opacity-30"></div>
    <script type="application/json" id="oma-data">${dataJson}</script>
    <script>
        const dataEl = document.getElementById("oma-data");
        const payload = JSON.parse(dataEl.textContent);
        const panel = document.getElementById("detailsPanel");
        const closeBtn = document.getElementById("closePanel");
        const canvas = document.getElementById("canvas");
        const viewport = document.getElementById("viewport");
        const edgesLayer = document.getElementById("edgesLayer");
        const nodesLayer = document.getElementById("nodesLayer");
        const goalText = document.getElementById("goalText");
        const liveOutput = document.getElementById("liveOutput");
        const selectedAssignee = document.getElementById("selectedAssignee");
        const selectedState = document.getElementById("selectedState");
        const selectedStart = document.getElementById("selectedStart");
        const selectedToolCalls = document.getElementById("selectedToolCalls");
        const selectedEnd = document.getElementById("selectedEnd");
        const selectedPromptTokens = document.getElementById("selectedPromptTokens");
        const selectedCompletionTokens = document.getElementById("selectedCompletionTokens");
        const selectedTokenRatio = document.getElementById("selectedTokenRatio");
        const svgNs = "http://www.w3.org/2000/svg";

        let scale = 1;
        let translate = { x: 0, y: 0 };

        let isDragging = false;
        let last = { x: 0, y: 0 };

        function updateTransform() {
            canvas.style.transform = \`
                translate(\${translate.x}px, \${translate.y}px)
                scale(\${scale})
            \`;
        }

        viewport.addEventListener("wheel", (e) => {
            e.preventDefault();

            const zoomIntensity = 0.0015;
            const delta = -e.deltaY * zoomIntensity;
            const newScale = Math.min(Math.max(0.4, scale + delta), 2.5);

            const rect = viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const dx = mouseX - translate.x;
            const dy = mouseY - translate.y;

            translate.x -= dx * (newScale / scale - 1);
            translate.y -= dy * (newScale / scale - 1);
            scale = newScale;
            updateTransform();
        });

        viewport.addEventListener("mousedown", (e) => {
            isDragging = true;
            last = { x: e.clientX, y: e.clientY };
            viewport.classList.add("cursor-grabbing");
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;

            const dx = e.clientX - last.x;
            const dy = e.clientY - last.y;
            translate.x += dx;
            translate.y += dy;
            last = { x: e.clientX, y: e.clientY };
            updateTransform();
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
            viewport.classList.remove("cursor-grabbing");
        });

        updateTransform();

        closeBtn.addEventListener("click", () => {
            panel.classList.add("hidden");
        });

        document.addEventListener("click", (e) => {
            const isClickInsidePanel = panel.contains(e.target);
            const isNode = e.target.closest(".node");

            if (!isClickInsidePanel && !isNode) {
                panel.classList.add("hidden");
            }
        });

        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        goalText.textContent = payload.goal ?? "";

        const statusStyles = {
            completed: { border: "border-tertiary", icon: "check_circle", iconColor: "text-tertiary", container: "bg-surface-container-lowest node-active-glow", statusColor: "text-on-surface-variant", chip: "STABLE" },
            failed: { border: "border-error", icon: "error", iconColor: "text-error", container: "bg-surface-container-lowest", statusColor: "text-error", chip: "FAILED" },
            blocked: { border: "border-outline", icon: "lock", iconColor: "text-outline", container: "bg-surface-container-low opacity-60 grayscale", statusColor: "text-on-surface-variant", chip: "BLOCKED" },
            skipped: { border: "border-outline", icon: "skip_next", iconColor: "text-outline", container: "bg-surface-container-low opacity-60", statusColor: "text-on-surface-variant", chip: "SKIPPED" },
            in_progress: { border: "border-secondary", icon: "sync", iconColor: "text-secondary", container: "bg-surface-container-low node-active-glow border border-outline-variant/20 shadow-[0_0_20px_rgba(253,192,3,0.1)]", statusColor: "text-secondary", chip: "ACTIVE_STREAM", spin: true },
            pending: { border: "border-outline", icon: "hourglass_empty", iconColor: "text-outline", container: "bg-surface-container-low opacity-60 grayscale", statusColor: "text-on-surface-variant", chip: "WAITING" },
        };

        function durationText(task) {
            const ms = task?.metrics?.durationMs ?? 0;
            const seconds = Math.max(0, ms / 1000).toFixed(1);
            return task.status === "completed" ? "DONE (" + seconds + "s)" : task.status.toUpperCase();
        }

        function renderLiveOutput(taskList) {
            liveOutput.innerHTML = "";
            const finished = taskList.every((task) => ["completed", "failed", "skipped", "blocked"].includes(task.status));
            const header = document.createElement("p");
            header.className = "text-tertiary";
            header.textContent = finished ? "[SYSTEM] Task graph execution finished." : "[SYSTEM] Task graph execution in progress.";
            liveOutput.appendChild(header);

            taskList.forEach((task) => {
                const p = document.createElement("p");
                p.className = task.status === "completed" ? "text-on-surface-variant" : task.status === "failed" ? "text-error" : "text-on-surface-variant";
                p.textContent = "[" + (task.assignee || "UNASSIGNED").toUpperCase() + "] " + task.title + " -> " + task.status.toUpperCase();
                liveOutput.appendChild(p);
            });
        }

        function renderDetails(task) {
            const metrics = task?.metrics ?? {};
            const statusLabel = (statusStyles[task.status] || statusStyles.pending).chip;
            const usage = metrics.tokenUsage ?? { input_tokens: 0, output_tokens: 0 };
            const inTokens = usage.input_tokens ?? 0;
            const outTokens = usage.output_tokens ?? 0;
            const total = inTokens + outTokens;
            const ratio = total > 0 ? Math.round((inTokens / total) * 100) : 0;

            selectedAssignee.textContent = task?.assignee || "UNASSIGNED";

            selectedState.textContent = "STATE: " + statusLabel;
            selectedStart.textContent = metrics.startMs ? new Date(metrics.startMs).toISOString() : "-";
            selectedEnd.textContent = metrics.endMs ? new Date(metrics.endMs).toISOString() : "-";

            selectedToolCalls.textContent = (metrics.toolCalls ?? []).length.toString();

            selectedPromptTokens.textContent = inTokens.toLocaleString();
            selectedCompletionTokens.textContent = outTokens.toLocaleString();
            selectedTokenRatio.style.width = ratio + "%";
        }

        function makeEdgePath(x1, y1, x2, y2) {
            return "M " + x1 + " " + y1 + " C " + (x1 + 42) + " " + y1 + ", " + (x2 - 42) + " " + y2 + ", " + x2 + " " + y2;
        }

        function renderDag(taskList) {
            const rawLayout = payload.layout ?? {};
            const positions = new Map(Object.entries(rawLayout.positions ?? {}));
            const width = Number(rawLayout.width ?? 1600);
            const height = Number(rawLayout.height ?? 700);
            const nodeW = Number(rawLayout.nodeW ?? 256);
            const nodeH = Number(rawLayout.nodeH ?? 142);
            canvas.style.width = width + "px";
            canvas.style.height = height + "px";

            edgesLayer.setAttribute("viewBox", "0 0 " + width + " " + height);
            edgesLayer.innerHTML = "";
            const defs = document.createElementNS(svgNs, "defs");
            const marker = document.createElementNS(svgNs, "marker");
            marker.setAttribute("id", "arrow");
            marker.setAttribute("markerWidth", "8");
            marker.setAttribute("markerHeight", "8");
            marker.setAttribute("refX", "7");
            marker.setAttribute("refY", "4");
            marker.setAttribute("orient", "auto");
            const markerPath = document.createElementNS(svgNs, "path");
            markerPath.setAttribute("d", "M0,0 L8,4 L0,8 z");
            markerPath.setAttribute("fill", "#40485d");
            marker.appendChild(markerPath);
            defs.appendChild(marker);
            edgesLayer.appendChild(defs);

            taskList.forEach((task) => {
                const to = positions.get(task.id);
                (task.dependsOn || []).forEach((depId) => {
                    const from = positions.get(depId);
                    if (!from || !to) return;
                    const edge = document.createElementNS(svgNs, "path");
                    edge.setAttribute("d", makeEdgePath(from.x + nodeW, from.y + nodeH / 2, to.x, to.y + nodeH / 2));
                    edge.setAttribute("fill", "none");
                    edge.setAttribute("stroke", "#40485d");
                    edge.setAttribute("stroke-width", "2");
                    edge.setAttribute("marker-end", "url(#arrow)");
                    edgesLayer.appendChild(edge);
                });
            });

            nodesLayer.innerHTML = "";
            taskList.forEach((task, idx) => {
                const pos = positions.get(task.id);
                const status = statusStyles[task.status] || statusStyles.pending;
                const nodeId = "#NODE_" + String(idx + 1).padStart(3, "0");
                const chips = [task.assignee ? task.assignee.toUpperCase() : "UNASSIGNED", status.chip];

                const node = document.createElement("div");
                node.className = "node absolute w-64 border-l-2 p-4 cursor-pointer " + status.border + " " + status.container;
                node.style.left = pos.x + "px";
                node.style.top = pos.y + "px";

                const rowTop = document.createElement("div");
                rowTop.className = "flex justify-between items-start mb-4";
                const nodeIdSpan = document.createElement("span");
                nodeIdSpan.className = "text-[10px] font-mono " + status.iconColor;
                nodeIdSpan.textContent = nodeId;
                const iconSpan = document.createElement("span");
                iconSpan.className = "material-symbols-outlined " + status.iconColor + " text-lg " + (status.spin ? "animate-spin" : "");
                iconSpan.textContent = status.icon;
                iconSpan.setAttribute("data-icon", status.icon);
                rowTop.appendChild(nodeIdSpan);
                rowTop.appendChild(iconSpan);

                const titleEl = document.createElement("h3");
                titleEl.className = "font-headline font-bold text-sm tracking-tight mb-1";
                titleEl.textContent = task.title;

                const statusLine = document.createElement("p");
                statusLine.className = "text-xs " + status.statusColor + " mb-4";
                statusLine.textContent = "STATUS: " + durationText(task);

                const chipRow = document.createElement("div");
                chipRow.className = "flex gap-2";
                chips.forEach((chip) => {
                    const chipEl = document.createElement("span");
                    chipEl.className = "px-2 py-0.5 bg-surface-variant text-[9px] font-mono text-on-surface-variant";
                    chipEl.textContent = chip;
                    chipRow.appendChild(chipEl);
                });

                node.appendChild(rowTop);
                node.appendChild(titleEl);
                node.appendChild(statusLine);
                node.appendChild(chipRow);

                node.addEventListener("click", () => {
                    renderDetails(task);
                    panel.classList.remove("hidden");
                });
                nodesLayer.appendChild(node);
            });

            renderLiveOutput(taskList);
        }

        renderDag(tasks);
    </script>
</body>
</html>`
}
