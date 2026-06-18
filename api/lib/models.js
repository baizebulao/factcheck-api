/**
 * 多模型适配器 — 统一接口调用不同 LLM 提供商
 *
 * 所有适配器实现同一接口：
 *   analyze(systemPrompt, userPrompt, apiKey) -> { content, model, latency }
 *
 * 新增模型只需在 MODELS 里注册即可。
 */

// ============================================================
// 模型注册表
// ============================================================

export const MODELS = {
  // 智谱 GLM 系列
  'glm-4-flash': {
    provider: 'zhipu',
    label: '智谱 GLM-4-Flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    cost: 0.0001,  // 每次约¥0.01
    speed: 'fast',
    strength: '速度快，成本低',
  },
  'glm-4-plus': {
    provider: 'zhipu',
    label: '智谱 GLM-4-Plus',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    cost: 0.05,
    speed: 'medium',
    strength: '推理能力强',
  },
  'glm-4': {
    provider: 'zhipu',
    label: '智谱 GLM-4',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    cost: 0.01,
    speed: 'medium',
    strength: '均衡',
  },

  // DeepSeek 系列
  'deepseek-chat': {
    provider: 'deepseek',
    label: 'DeepSeek Chat',
    endpoint: 'https://api.deepseek.com/chat/completions',
    cost: 0.001,
    speed: 'medium',
    strength: '逻辑推理强',
  },

  // 通义千问系列（阿里云）
  'qwen-plus': {
    provider: 'dashscope',
    label: '通义千问 Plus',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    cost: 0.004,
    speed: 'medium',
    strength: '中文理解强',
  },

  // Kimi（月之暗面）
  'moonshot-v1-8k': {
    provider: 'moonshot',
    label: 'Kimi',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    cost: 0.012,
    speed: 'medium',
    strength: '长文本分析',
  },
};

// ============================================================
// 统一调用接口
// ============================================================

/**
 * 调用指定模型进行分析
 * @param {string} modelId - 模型ID（见 MODELS）
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userPrompt - 用户输入
 * @param {string} apiKey - 对应提供商的 API Key
 * @returns {Promise<{content: string, model: string, latency: number}>}
 */
export async function callModel(modelId, systemPrompt, userPrompt, apiKey) {
  const model = MODELS[modelId];
  if (!model) throw new Error(`未知模型: ${modelId}`);

  const start = Date.now();

  const response = await fetch(model.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${model.label} API 错误 (${response.status}): ${errText.substring(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${model.label} 返回为空`);

  return {
    content,
    model: modelId,
    modelLabel: model.label,
    latency: Date.now() - start,
  };
}

/**
 * 从环境变量获取指定提供商的 API Key
 */
export function getApiKey(provider) {
  const envMap = {
    zhipu: 'ZHIPU_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    dashscope: 'DASHSCOPE_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
  };
  return process.env[envMap[provider]] || '';
}

/**
 * 获取所有可用的模型（有对应 API Key 的）
 */
export function getAvailableModels() {
  return Object.entries(MODELS)
    .filter(([id, m]) => getApiKey(m.provider))
    .map(([id, m]) => ({ id, ...m }));
}

/**
 * 从用户传入的自定义 Key 构建可用模型列表
 * 用户可以传 { provider: 'zhipu', apiKey: 'xxx' } 等
 */
export function resolveUserModels(userKeys) {
  if (!userKeys || typeof userKeys !== 'object') return [];
  
  const models = [];
  for (const [id, m] of Object.entries(MODELS)) {
    const key = userKeys[m.provider];
    if (key) {
      models.push({ id, ...m, apiKey: key });
    }
  }
  return models;
}
