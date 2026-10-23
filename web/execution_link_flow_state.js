const durationMs = 450;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value) => typeof value === "string" && value.length > 0;
const index = (value) => Number.isSafeInteger(value) && value >= 0;
const edgeKey = (source, slot, target, input) => JSON.stringify([source, slot, target, input]);

function getLink(graph, linkId) {
    return graph.getLink?.(linkId) ?? graph.links?.get?.(linkId);
}

function portShape(port) {
    return [port, port.name, port.type, port.link, port.links ? [...port.links] : null];
}

function samePort(shape, port) {
    const links = port.links;
    return shape[0] === port && shape[1] === port.name && shape[2] === port.type && shape[3] === port.link
        && (shape[4] === null ? !links : shape[4].length === links?.length && shape[4].every((v, i) => v === links[i]));
}

/**
 * 记录导出开始时的图实例与拓扑，不保存控件值、标题或工作流内容。
 * @param {object} graph 正在导出的根图。
 * @returns {object|null} 实例快照；缺少必要宿主接口时返回 null。
 * @throws {TypeError} 宿主拓扑访问异常由调用方按观测失败隔离，不能中断原生导出。
 */
export function captureGraphIdentity(graph) {
    if (!graph || !Number.isSafeInteger(graph._version) || !Array.isArray(graph._nodes) || !graph.links?.values) return null;
    return { graph, version: graph._version,
        nodes: graph._nodes.map((node) => ({ node, id: node.id, type: node.type, mode: node.mode,
            inputs: node.inputs.map(portShape), outputs: node.outputs.map(portShape) })),
        links: [...graph.links.values()].map((link) => [link, link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot]),
    };
}

/**
 * 核对导出及提交期间的图实例、节点和端口；图版本变化即保守失效，包括改动后恢复。
 * @param {object|null} snapshot 导出开始时的快照。
 * @param {object} graph 当前根图。
 * @returns {boolean} 是否仍可将导出唯一关联到原始画布实例。
 * @throws {TypeError} 宿主拓扑访问异常须由调用方隔离。
 */
export function graphIdentityMatches(snapshot, graph) {
    if (!snapshot || snapshot.graph !== graph || snapshot.version !== graph._version || snapshot.nodes.length !== graph._nodes.length
        || snapshot.links.length !== graph.links.size) return false;
    return snapshot.nodes.every(({ node, id: nodeId, type, mode, inputs, outputs }, i) =>
        graph._nodes[i] === node && node.graph === graph && node.id === nodeId && node.type === type && node.mode === mode
        && node.inputs.length === inputs.length && node.outputs.length === outputs.length
        && inputs.every((shape, j) => samePort(shape, node.inputs[j])) && outputs.every((shape, j) => samePort(shape, node.outputs[j])))
        && snapshot.links.every(([link, linkId, source, slot, target, input]) => getLink(graph, linkId) === link
            && link.id === linkId && link.origin_id === source && link.origin_slot === slot && link.target_id === target && link.target_slot === input);
}

function edgeMatches(edge, graph, outputLinks) {
    const { source, target, input, output, link } = edge;
    if (!outputLinks.has(output)) outputLinks.set(output, new Set(output.links ?? []));
    return graph.getNodeById(source.id) === source && graph.getNodeById(target.id) === target
        && source.graph === graph && target.graph === graph && source.mode === 0 && target.mode === 0
        && source.type === edge.sourceType && target.type === edge.targetType
        && getLink(graph, edge.linkId) === link && link.origin_id === source.id && link.target_id === target.id
        && link.origin_slot === edge.sourceSlot && link.target_slot === edge.targetSlot
        && source.outputs[edge.sourceSlot] === output && target.inputs[edge.targetSlot] === input
        && output.name === edge.outputName && output.type === edge.outputType && samePort(edge.inputShape, input)
        && input.name === edge.inputName && input.link === edge.linkId && outputLinks.get(output).has(edge.linkId);
}

function validEvent(event) {
    return event?.schema === 1 && typeof event.run_token === "string" && uuid.test(event.run_token)
        && id(event.prompt_id) && id(event.node_id) && index(event.event_id) && index(event.call_index)
        && Array.isArray(event.edges) && event.edges.every((edge) => edge && id(edge.source_node) && index(edge.source_slot)
            && id(edge.target_node) && edge.target_node === event.node_id && id(edge.target_input));
}

/** 维护一次连接中的提交实例、交付去重和短脉冲；调用方提供单调毫秒时钟，本类不启动定时器。 */
export class LinkFlowState {
    runs = new Map();
    terminals = new Map();
    submissionOrder = 0;

    /**
     * 从 API 直接边建立一次提交快照，无法一一匹配时不登记。
     * @param {object} graph 当前根图，必须提供递增版本和原生实例解析接口。
     * @param {object} apiPrompt 原生导出的 API 节点和输入；仅提取边坐标。
     * @param {string} runToken 每次实际提交唯一的 UUID v4。
     * @returns {boolean} 是否存在至少一条可确认的直接边。
     * @throws {TypeError} 宿主拓扑访问异常须由调用方隔离，不影响原生提交。
     */
    prepare(graph, apiPrompt, runToken) {
        if (typeof runToken !== "string" || !uuid.test(runToken) || this.runs.has(runToken) || !apiPrompt || typeof apiPrompt !== "object"
            || !Number.isSafeInteger(graph?._version)) return false;
        const edges = new Map();
        const outputLinks = new Map();
        for (const [targetId, nodePrompt] of Object.entries(apiPrompt)) {
            const target = graph.getNodeById(targetId);
            if (!target || String(target.id) !== targetId || target.mode !== 0 || target.type !== nodePrompt?.class_type) continue;
            for (const [inputName, value] of Object.entries(nodePrompt.inputs ?? {})) {
                if (!Array.isArray(value) || value.length !== 2 || !id(value[0]) || !index(value[1])) continue;
                const source = graph.getNodeById(value[0]);
                const sourcePrompt = apiPrompt[value[0]];
                const inputs = target.inputs.filter((input) => input.name === inputName);
                if (!source || String(source.id) !== value[0] || source.mode !== 0 || source.type !== sourcePrompt?.class_type || inputs.length !== 1) continue;
                const input = inputs[0], output = source.outputs[value[1]], link = getLink(graph, input.link);
                if (!output || !link) continue;
                const edge = { source, target, input, output, link, linkId: link.id, sourceSlot: value[1], targetSlot: target.inputs.indexOf(input),
                    inputName, inputShape: portShape(input), outputName: output.name, outputType: output.type, sourceType: source.type, targetType: target.type };
                if (edgeMatches(edge, graph, outputLinks)) edges.set(edgeKey(value[0], value[1], targetId, inputName), edge);
            }
        }
        if (!edges.size) return false;
        this.runs.set(runToken, { graph, version: graph._version, edges, promptId: null, sequence: -1, terminal: false, pulses: new Map(), order: ++this.submissionOrder });
        return true;
    }

    /**
     * 绑定 HTTP 响应任务 ID；冲突时释放提交，已终止任务不能复活。
     * @param {string} runToken 已登记提交的 UUID。
     * @param {string} promptId HTTP 响应的任务标识。
     * @returns {boolean} 是否仍为可接收交付的活跃提交；无效值直接返回 false，不主动抛异常。
     */
    acknowledge(runToken, promptId) {
        const run = this.runs.get(runToken);
        if (!run || !id(promptId)) { this.discard(runToken); return false; }
        if (run.promptId !== null && run.promptId !== promptId) { this.discard(runToken); return false; }
        run.promptId = promptId;
        const terminal = this.terminals.get(promptId);
        if (terminal) { run.terminal = true; if (terminal.outcome !== "success") run.pulses.clear(); }
        if (run.terminal) { if (!run.pulses.size) this.discard(runToken); return false; }
        return true;
    }

    /**
     * 核对协议、提交和真实画布边后接收交付，重复或旧序号不延长脉冲。
     * @param {object} event schema 1 的交付元数据，非法字段被忽略。
     * @param {object} graph 当前根图，必须与提交实例相同。
     * @param {number} nowMs 本机单调时钟，单位毫秒。
     * @returns {number} 本次新建脉冲数；同一 60 Hz 合并窗口的相同边只建一次。
     * @throws {TypeError} 宿主图访问异常须由调用方隔离。
     */
    accept(event, graph, nowMs) {
        this.#pruneTerminals(nowMs);
        if (!validEvent(event) || !Number.isFinite(nowMs)) return 0;
        const run = this.runs.get(event.run_token);
        if (!run || run.terminal || (run.promptId !== null && run.promptId !== event.prompt_id) || event.event_id <= run.sequence) return 0;
        if (run.graph !== graph || run.version !== graph._version) { this.discard(event.run_token); return 0; }
        if (this.terminals.has(event.prompt_id)) { this.discard(event.run_token); return 0; }
        run.promptId = event.prompt_id;
        run.sequence = event.event_id;
        let count = 0;
        const outputLinks = new Map();
        for (const item of event.edges) {
            const edge = run.edges.get(edgeKey(item.source_node, item.source_slot, item.target_node, item.target_input));
            if (!edge || !edgeMatches(edge, graph, outputLinks)) continue;
            const pulse = run.pulses.get(edge.linkId);
            if (pulse && Math.floor(pulse.started / (1000 / 60)) === Math.floor(nowMs / (1000 / 60))) continue;
            run.pulses.set(edge.linkId, { edge, started: nowMs });
            count++;
        }
        return count;
    }

    /**
     * 记录终止消息；success 仅保留已确认脉冲剩余时长，其他结果立即停止。
     * @param {string} promptId 原生任务标识，允许先于 HTTP 确认到达。
     * @param {string} outcome success/error/interrupted/cancelled；其他值忽略。
     * @param {number} nowMs 本机单调时钟，单位毫秒；早到记录最多保留 30 秒/256 条。
     * @returns {void} 无效控制消息不改变状态，不主动抛异常。
     */
    finish(promptId, outcome, nowMs) {
        if (!id(promptId) || !["success", "error", "interrupted", "cancelled"].includes(outcome) || !Number.isFinite(nowMs)) return;
        this.#pruneTerminals(nowMs);
        this.terminals.set(promptId, { outcome, at: nowMs, cutoff: this.submissionOrder });
        while (this.terminals.size > 256) this.#expireTerminal(this.terminals.keys().next().value);
        for (const [token, run] of this.runs) {
            if (run.promptId !== promptId) continue;
            run.terminal = true;
            if (outcome !== "success") run.pulses.clear();
            if (!run.pulses.size) this.discard(token);
        }
    }

    /** 丢弃 runToken 对应提交及脉冲；未知 token 为无操作，返回 void，不主动抛异常。 */
    discard(runToken) { this.runs.delete(runToken); }

    /** 连接、设置或工作流退出时释放全部关联和终止记录；无参数，返回 void，可重复调用，不主动抛异常。 */
    clear() { this.runs.clear(); this.terminals.clear(); this.submissionOrder = 0; }

    /** 隐藏时丢弃视觉积压并保留身份/终止清理；无参数，返回 void，不主动抛异常，恢复后只接收新交付。 */
    dropPulses() {
        for (const [token, run] of this.runs) { run.pulses.clear(); if (run.terminal) this.discard(token); }
    }

    /**
     * 绘制前重新核对实例及端口并移除过期项，不补播历史交付。
     * @param {object} graph 当前可见根图。
     * @param {number} nowMs 本机单调时钟，单位毫秒。
     * @returns {Array<{linkId: number, progress: number}>} 活跃连线及 0–1 进度，450 ms 时移除。
     * @throws {TypeError} 宿主图访问异常须由调用方隔离。
     */
    activeLinks(graph, nowMs) {
        this.#pruneTerminals(nowMs);
        const links = new Map();
        const outputLinks = new Map();
        for (const [token, run] of this.runs) {
            if (run.graph !== graph || run.version !== graph?._version) { this.discard(token); continue; }
            for (const [linkId, pulse] of run.pulses) {
                const elapsed = nowMs - pulse.started;
                if (elapsed < 0 || elapsed >= durationMs || !edgeMatches(pulse.edge, graph, outputLinks)) { run.pulses.delete(linkId); continue; }
                const progress = elapsed / durationMs;
                if (!links.has(linkId) || progress < links.get(linkId)) links.set(linkId, progress);
            }
            if (run.terminal && !run.pulses.size) this.discard(token);
        }
        return [...links].map(([linkId, progress]) => ({ linkId, progress }));
    }

    #pruneTerminals(nowMs) {
        for (const [promptId, terminal] of this.terminals) if (nowMs - terminal.at > 30000) this.#expireTerminal(promptId);
    }

    #expireTerminal(promptId) {
        const terminal = this.terminals.get(promptId);
        // 控制记录过期前，撤销当时尚未绑定身份的候选，避免超慢 HTTP 响应复活已结束任务。
        for (const [token, run] of this.runs) if (run.promptId === null && run.order <= terminal.cutoff) this.discard(token);
        this.terminals.delete(promptId);
    }
}
