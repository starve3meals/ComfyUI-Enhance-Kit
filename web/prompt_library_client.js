import { api } from "../../scripts/api.js";

const endpoint = "/enhance-kit/prompt-library";

async function request(path, body, signal) {
    const options = { cache: "no-store", signal };
    if (body !== undefined) {
        options.method = "POST";
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(body);
    }
    const response = await api.fetchApi(path, options);
    let data;
    try {
        data = await response.json();
    } catch (cause) {
        const error = new Error(`提示词库响应无法读取（HTTP ${response.status}），请检查服务。`, { cause });
        error.status = response.status;
        throw error;
    }
    if (!response.ok) {
        const error = new Error(data.error?.message || `提示词库请求失败（HTTP ${response.status}）。`);
        error.status = response.status;
        error.code = data.error?.code;
        throw error;
    }
    return data;
}

/** 读取当前用户的完整库；signal 可取消读取，失败时抛错，不返回旧缓存。 */
export function readLibrary({ signal } = {}) {
    return request(endpoint, undefined, signal);
}

/** 按 expectedRevision 修改库并返回新库；冲突抛错，取消请求不代表回滚写入。 */
export function mutateLibrary(expectedRevision, action, data, { signal } = {}) {
    return request(endpoint, { expected_revision: expectedRevision, action, data }, signal);
}

/** 按稳定 ID 读取当前正文快照；失效 ID 或请求失败抛错，空正文有效。 */
export function resolvePrompt(promptId, { signal } = {}) {
    return request(`${endpoint}/resolve`, { prompt_id: promptId }, signal);
}
