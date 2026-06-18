/**
 * /api/health — 健康检查 + 模型状态
 */

export default async function handler(req, res) {
  const bingKey = process.env.BING_API_KEY ? true : false;
  const zhipuKey = process.env.ZHIPU_API_KEY ? true : false;
  const deepseekKey = process.env.DEEPSEEK_API_KEY ? true : false;

  res.status(200).json({
    status: 'ok',
    service: 'factcheck-api',
    version: '1.0.0',
    models: {
      zhipu: zhipuKey,
      deepseek: deepseekKey,
    },
    search: bingKey,
    timestamp: new Date().toISOString(),
  });
}
