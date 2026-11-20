/**
 * Vercel 后端函数：/api/ai（预留的大模型接口）
 *
 * 当前前端默认使用本地模拟（js/ai.js 里 provider: 'mock'），这个函数不会被调用。
 * 以后要接真 AI：
 *   1. 在 Vercel 项目 Settings → Environment Variables 里配置：
 *        AI_API_KEY   大模型平台的 API Key（只存在后端，不会暴露到网页里）
 *        AI_BASE_URL  OpenAI 兼容接口地址，例如 https://api.deepseek.com/v1
 *        AI_MODEL     模型名，例如 deepseek-chat
 *   2. 把 js/ai.js 里的 provider 改成 'remote'，重新部署
 *
 * 请求格式：POST { task: 'parsePreference' | 'explain' | 'adjustToday', payload: {...} }
 * 返回格式：{ result: ... }
 */

const PROMPTS = {
  parsePreference: (p) => `你是外卖点餐助手。把用户的口味描述解析成 JSON，只输出 JSON，不要其他文字。
可选口味：${p.flavorOptions.join('、')}
可选忌口：${p.avoidOptions.join('、')}
输出格式：{"flavors":[],"avoid":[],"noFried":true|false|null,"lowOil":true|false|null,"wantStaple":true|false|null}
规则：flavors 和 avoid 只能从可选项中选；没提到的布尔项填 null。
用户描述：${p.text}`,

  explain: (p) => `你是外卖点餐助手。用一句不超过 40 字的中文，向一个独自在办公室吃午饭的用户说明为什么推荐这道菜。
语气自然、具体，不要夸张。只输出这句话。
菜品信息：${JSON.stringify(p.item)}
用户昨天吃的主菜：${p.yesterday || '无记录'}`,

  adjustToday: (p) => `把用户今天的临时需求解析成 JSON，只输出 JSON。
格式：{"boostMethods":[],"boostFlavors":[]}
做法可选：炒、蒸、煮、炖、烤、煎、炸、凉拌；口味可选：清淡、咸鲜、香辣、麻辣、酸辣、酸甜、酱香
用户输入：${p.text}`,
};

const JSON_TASKS = new Set(['parsePreference', 'adjustToday']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { AI_API_KEY, AI_BASE_URL, AI_MODEL } = process.env;
  if (!AI_API_KEY || !AI_BASE_URL || !AI_MODEL) {
    // 未配置时返回 503，前端会自动回退到本地模拟
    res.status(503).json({ error: 'AI not configured' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { task, payload } = body;
  const build = PROMPTS[task];
  if (!build) {
    res.status(400).json({ error: 'Unknown task' });
    return;
  }

  try {
    const r = await fetch(`${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: JSON_TASKS.has(task) ? 0 : 0.7,
        messages: [{ role: 'user', content: build(payload) }],
      }),
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
    const data = await r.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();

    let result = text;
    if (JSON_TASKS.has(task)) {
      const m = text.match(/\{[\s\S]*\}/);
      result = m ? JSON.parse(m[0]) : null;
    }
    res.status(200).json({ result });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
