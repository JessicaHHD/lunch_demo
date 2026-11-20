/**
 * 页面逻辑：偏好设置 → 今日推荐（3 选 1 / 换一个）→ 就它了 → 模拟到下一天
 */
(function () {
  const { DISHES, FLAVOR_OPTIONS, AVOID_OPTIONS } = window.LunchData;
  const Engine = window.LunchEngine;
  const AI = window.LunchAI;
  const Store = window.LunchStore;

  const $app = document.getElementById('app');
  let state = Store.load();
  let view = state.prefs ? 'home' : 'prefs';
  let draft = null;                // 偏好设置页的编辑中草稿
  let parseNote = '';              // AI 解析结果提示
  const reasonCache = {};          // 推荐理由缓存：`${dayIndex}:${dishId}` → 文案

  const EXAMPLE_TEXT = '我不吃香菜和内脏，口味偏咸鲜，能吃一点辣，最近在控油，别给我推油炸的，要有米饭能吃饱';

  // ---------------- 工具 ----------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function workday(baseISO, n) {
    const d = new Date(baseISO + 'T12:00:00');
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    let left = n;
    while (left > 0) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0 && d.getDay() !== 6) left--;
    }
    return d;
  }
  function dayLabel(i) {
    const d = workday(state.baseDate, i);
    const w = '日一二三四五六'[d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 周${w}`;
  }

  function persist() { Store.save(state); }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------------- 推荐数据 ----------------
  function computeToday() {
    const res = Engine.rank(DISHES, state.prefs, state.history, state.dayIndex);
    const t = state.today;
    const valid = t.dayIndex === state.dayIndex &&
      t.recIds.length > 0 &&
      t.recIds.every((id) => res.ranked.some((r) => r.dish.id === id));
    if (!valid) {
      state.today = { dayIndex: state.dayIndex, recIds: [], skipped: t.dayIndex === state.dayIndex ? t.skipped : [], pickedId: t.dayIndex === state.dayIndex ? t.pickedId : null };
      state.today.recIds = Engine.pick(res.ranked, 3, [], state.today.skipped).map((r) => r.dish.id);
      persist();
    }
    const items = state.today.recIds.map((id) => res.ranked.find((r) => r.dish.id === id)).filter(Boolean);
    return { res, items };
  }

  // ---------------- 视图：顶部 ----------------
  function header() {
    return `
      <header class="top">
        <div class="brand">
          <span class="logo">午</span>
          <div>
            <div class="brand-name">今天吃啥</div>
            <div class="brand-sub">第 ${state.dayIndex + 1} 天 · ${dayLabel(state.dayIndex)}</div>
          </div>
        </div>
        <nav class="nav">
          <button class="nav-btn ${view === 'home' ? 'on' : ''}" data-act="go-home" ${state.prefs ? '' : 'disabled'}>推荐</button>
          <button class="nav-btn ${view === 'history' ? 'on' : ''}" data-act="go-history" ${state.prefs ? '' : 'disabled'}>记录</button>
          <button class="nav-btn ${view === 'prefs' ? 'on' : ''}" data-act="go-prefs">偏好</button>
        </nav>
      </header>`;
  }

  // ---------------- 视图：偏好设置 ----------------
  function chip(group, value, on) {
    return `<button class="chip ${on ? 'on' : ''} ${group === 'avoid' ? 'chip-avoid' : ''}" data-act="toggle-chip" data-group="${group}" data-value="${esc(value)}">${on && group === 'avoid' ? '✕ ' : ''}${esc(value)}</button>`;
  }
  function toggleRow(key, title, desc) {
    const on = !!draft[key];
    return `
      <label class="toggle-row" data-act="toggle-bool" data-key="${key}">
        <div><div class="toggle-title">${title}</div><div class="toggle-desc">${desc}</div></div>
        <span class="switch ${on ? 'on' : ''}"><span></span></span>
      </label>`;
  }

  function renderPrefs() {
    if (!draft) draft = JSON.parse(JSON.stringify(state.prefs || Store.DEFAULT_PREFS));
    const first = !state.prefs;
    return `
      ${header()}
      <main class="page">
        ${first ? `<div class="intro"><h1>花 30 秒告诉我你的口味</h1><p>设置一次，以后每天中午直接给你 3 个选项，不用再翻。</p></div>` : `<h2 class="section-h">我的偏好</h2>`}

        <section class="card ai-box">
          <div class="ai-head"><span class="ai-badge">AI</span> 一句话描述你的口味 <span class="mock-tag">当前为本地模拟</span></div>
          <textarea id="nl-input" rows="3" placeholder="例如：我不吃香菜和内脏，口味偏咸鲜，最近在控油，要有米饭">${esc(draft._text || '')}</textarea>
          <div class="ai-actions">
            <button class="btn-ghost" data-act="fill-example">填入示例</button>
            <button class="btn-dark" data-act="parse-nl">解析并填入下方 ↓</button>
          </div>
          ${parseNote ? `<div class="parse-note">${parseNote}</div>` : ''}
        </section>

        <section class="card">
          <div class="field-h">喜欢的口味 <span class="hint">多选，影响排序</span></div>
          <div class="chips">${FLAVOR_OPTIONS.map((f) => chip('flavors', f, draft.flavors.includes(f))).join('')}</div>
        </section>

        <section class="card">
          <div class="field-h">不吃的食材 <span class="hint hard">硬性排除，绝不推荐</span></div>
          <div class="chips">${AVOID_OPTIONS.map((a) => chip('avoid', a, draft.avoid.includes(a))).join('')}</div>
        </section>

        <section class="card">
          ${toggleRow('noFried', '不要油炸', '直接排除炸物；候选太少时才会放宽并提示')}
          ${toggleRow('lowOil', '少油优先', '蒸、煮、炖等低油做法排在前面')}
          ${toggleRow('wantStaple', '要有主食', '优先推荐自带米饭 / 面 / 粉的套餐')}
          ${toggleRow('avoidSameIngredient', '主料也别连着吃', '默认只避开同一道菜；打开后昨天吃鸡，今天也不推鸡')}
        </section>

        <div class="rule-note">“连续两天不吃同一道主菜”会自动执行：不同店铺的同款菜（如两家的宫保鸡丁）也会一起避开。</div>

        <button class="btn-primary block" data-act="save-prefs">${first ? '保存，看今天吃什么' : '保存偏好'}</button>
      </main>`;
  }

  // ---------------- 视图：今日推荐 ----------------
  function funnel(res) {
    const a = res.removed.avoid.length, r = res.removed.repeat.length, f = res.removed.fried.length;
    const left = res.ranked.length;
    let repeatLine = '';
    if (res.yesterday && r) {
      const names = [...new Set(res.removed.repeat.map((x) => `${x.dish.name}（${x.dish.shop}）`))];
      repeatLine = `<div class="funnel-detail">昨天吃了 <b>${esc(res.yesterday.mainDish)}</b>，今天已排除：${names.map(esc).join('、')}</div>`;
    }
    return `
      <section class="funnel">
        <div class="funnel-h">今天的筛选过程</div>
        <div class="funnel-row">
          <span class="fn-num">${res.total}</span><span class="fn-label">道菜</span>
          <span class="fn-arrow">→</span>
          <span class="fn-pill red">忌口 −${a}</span>
          <span class="fn-pill amber">昨天同款 −${r}</span>
          <span class="fn-pill gray">油炸 −${f}</span>
          <span class="fn-arrow">→</span>
          <span class="fn-num">${left}</span><span class="fn-label">道候选</span>
        </div>
        ${repeatLine}
        ${res.relaxed.map((x) => `<div class="relax">⚠ ${esc(x)}</div>`).join('')}
      </section>`;
  }

  function dishCard(item, idx, picked) {
    const d = item.dish;
    const key = `${state.dayIndex}:${d.id}`;
    const reason = reasonCache[key];
    const isPicked = picked === d.id;
    return `
      <article class="dish ${isPicked ? 'picked' : ''} ${picked && !isPicked ? 'dim' : ''}">
        <div class="dish-top">
          <div class="dish-rank">${idx + 1}</div>
          <div class="dish-main">
            <div class="dish-name">${esc(d.name)}</div>
            <div class="dish-meta">${esc(d.shop)} · ${d.method} · ★${d.rating} · 约${d.eta}分钟</div>
          </div>
          <div class="dish-price">¥${d.price}</div>
        </div>
        <div class="tags">
          ${item.hits.map((h) => `<span class="tag ok">✓ ${esc(h)}</span>`).join('')}
          ${item.warns.map((w) => `<span class="tag warn">! ${esc(w)}</span>`).join('')}
        </div>
        <div class="reason" data-reason="${d.id}">
          <span class="ai-dot">AI</span>
          <span class="reason-text">${reason ? esc(reason) : '<span class="shimmer">正在生成推荐理由…</span>'}</span>
        </div>
        ${picked ? (isPicked ? `<div class="picked-label">✓ 今天就吃这个</div>` : '') : `
        <div class="dish-actions">
          <button class="btn-ghost" data-act="swap" data-idx="${idx}">换一个</button>
          <button class="btn-primary" data-act="choose" data-id="${d.id}">就它了</button>
        </div>`}
      </article>`;
  }

  function renderHome() {
    const { res, items } = computeToday();
    const picked = state.today.pickedId;
    const pickedDish = picked ? DISHES.find((d) => d.id === picked) : null;
    const y = res.yesterday;

    let body;
    if (!items.length) {
      body = `<div class="empty card">符合忌口的菜太少了，暂时推荐不出来。<br>可以到「偏好」里减少几项忌口试试。</div>`;
    } else {
      body = items.map((it, i) => dishCard(it, i, picked)).join('');
    }

    return `
      ${header()}
      <main class="page">
        <div class="greet">
          <h1>${picked ? '今天的午饭定好了' : '今天中午，从这 3 个里挑一个'}</h1>
          <div class="yesterday">${y ? `昨天吃的：${esc(y.name)}（${esc(y.shop)}）` : '还没有昨天的记录，从今天开始积累'}</div>
        </div>

        ${funnel(res)}

        ${body}

        ${pickedDish ? `
          <section class="done card">
            <div class="done-title">已模拟下单：${esc(pickedDish.name)} · ¥${pickedDish.price}</div>
            <div class="done-sub">明天会自动避开「${esc(pickedDish.mainDish)}」${state.prefs.avoidSameIngredient ? `和所有「${esc(pickedDish.mainIngredient)}」类主菜` : '（包括其他店铺的同款）'}</div>
            <button class="btn-primary block" data-act="next-day">模拟到下一天 →</button>
            <button class="btn-link" data-act="unpick">改主意了，重新选</button>
          </section>` : `
          <div class="skip-row"><button class="btn-link" data-act="next-day">今天不点了，跳到下一天</button></div>`}
      </main>`;
  }

  // ---------------- 视图：记录 ----------------
  function renderHistory() {
    const list = [...state.history].sort((a, b) => b.dayIndex - a.dayIndex);
    const rows = list.map((h) => {
      const prev = state.history.find((x) => x.dayIndex === h.dayIndex - 1);
      const ok = !prev || prev.mainDish !== h.mainDish;
      return `
        <div class="hist-row">
          <div class="hist-day">第${h.dayIndex + 1}天<br><span>${dayLabel(h.dayIndex)}</span></div>
          <div class="hist-main"><div class="hist-name">${esc(h.name)}</div><div class="hist-meta">${esc(h.shop)} · 主菜：${esc(h.mainDish)} · ¥${h.price}</div></div>
          <div class="hist-flag ${ok ? 'ok' : 'bad'}">${prev ? (ok ? '✓ 与前一天不同' : '与前一天重复') : '首条记录'}</div>
        </div>`;
    }).join('');
    return `
      ${header()}
      <main class="page">
        <h2 class="section-h">最近吃了什么</h2>
        <section class="card">${rows || '<div class="empty-mini">还没有记录。去「推荐」里选一道，再点“模拟到下一天”。</div>'}</section>
        <div class="reset-box">
          <div class="hint">演示用：清空偏好和记录，回到第一次打开的状态</div>
          <button class="btn-ghost" data-act="reset">重置 Demo</button>
        </div>
      </main>`;
  }

  // ---------------- 渲染 ----------------
  function render() {
    if (view === 'prefs') $app.innerHTML = renderPrefs();
    else if (view === 'history') $app.innerHTML = renderHistory();
    else $app.innerHTML = renderHome();
    if (view === 'home') fillReasons();
  }

  async function fillReasons() {
    const { res, items } = computeToday();
    const usedFacts = new Set();
    for (const [index, it] of items.entries()) {
      const key = `${state.dayIndex}:${it.dish.id}`;
      if (reasonCache[key]) continue;
      const text = await AI.explain(it, { yesterday: res.yesterday, prefs: state.prefs, index, usedFacts });
      reasonCache[key] = text;
      const el = document.querySelector(`[data-reason="${it.dish.id}"] .reason-text`);
      if (el) el.textContent = text;
    }
  }

  // ---------------- 交互 ----------------
  function sanitizeParsed(p) {
    return {
      flavors: (p.flavors || []).filter((f) => FLAVOR_OPTIONS.includes(f)),
      avoid: (p.avoid || []).filter((a) => AVOID_OPTIONS.includes(a)),
      noFried: typeof p.noFried === 'boolean' ? p.noFried : null,
      lowOil: typeof p.lowOil === 'boolean' ? p.lowOil : null,
      wantStaple: typeof p.wantStaple === 'boolean' ? p.wantStaple : null,
    };
  }

  const actions = {
    'go-home': () => { if (state.prefs) { view = 'home'; draft = null; parseNote = ''; } },
    'go-history': () => { if (state.prefs) { view = 'history'; draft = null; parseNote = ''; } },
    'go-prefs': () => { view = 'prefs'; draft = null; parseNote = ''; },

    'toggle-chip': (el) => {
      const g = el.dataset.group, v = el.dataset.value;
      const arr = draft[g];
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1); else arr.push(v);
    },
    'toggle-bool': (el) => { const k = el.dataset.key; draft[k] = !draft[k]; },

    'fill-example': () => { draft._text = EXAMPLE_TEXT; },

    'parse-nl': async () => {
      const text = (document.getElementById('nl-input').value || '').trim();
      draft._text = text;
      if (!text) { toast('先写一句话描述你的口味'); return; }
      const p = sanitizeParsed(await AI.parsePreference(text));
      draft.flavors = [...new Set([...draft.flavors, ...p.flavors])];
      draft.avoid = [...new Set([...draft.avoid, ...p.avoid])];
      ['noFried', 'lowOil', 'wantStaple'].forEach((k) => { if (p[k] !== null) draft[k] = p[k]; });
      const bits = [];
      if (p.flavors.length) bits.push(`口味 ${p.flavors.join('、')}`);
      if (p.avoid.length) bits.push(`忌口 ${p.avoid.join('、')}`);
      if (p.noFried) bits.push('不要油炸');
      if (p.lowOil) bits.push('少油');
      if (p.wantStaple) bits.push('要主食');
      parseNote = bits.length ? `识别到：${bits.map(esc).join(' · ')}。已勾选到下方，可以手动调整。` : '没识别出具体偏好，可以直接在下方勾选。';
    },

    'save-prefs': () => {
      const text = document.getElementById('nl-input');
      if (text) draft._text = text.value;
      const { _text, ...prefs } = draft;
      const changed = JSON.stringify(prefs) !== JSON.stringify(state.prefs);
      state.prefs = prefs;
      if (changed) state.today = { dayIndex: state.dayIndex, recIds: [], skipped: [], pickedId: state.today.dayIndex === state.dayIndex ? state.today.pickedId : null };
      persist();
      draft = null; parseNote = '';
      view = 'home';
      toast('偏好已保存');
    },

    swap: (el) => {
      const idx = Number(el.dataset.idx);
      const { res } = computeToday();
      const ids = state.today.recIds;
      const out = ids[idx];
      const keep = ids.filter((_, i) => i !== idx);
      const skipped = [...new Set([...state.today.skipped, out])];
      const next = Engine.pick(res.ranked, 3, keep, skipped).find((r) => !keep.includes(r.dish.id));
      if (!next) { toast('符合条件的菜已经换完了'); return; }
      state.today.skipped = skipped;
      ids[idx] = next.dish.id;
      persist();
    },

    choose: (el) => {
      const d = DISHES.find((x) => x.id === el.dataset.id);
      state.today.pickedId = d.id;
      state.history = state.history.filter((h) => h.dayIndex !== state.dayIndex);
      state.history.push({
        dayIndex: state.dayIndex, dishId: d.id, name: d.name, shop: d.shop,
        mainDish: d.mainDish, mainIngredient: d.mainIngredient, price: d.price,
      });
      persist();
      toast(`已模拟下单：${d.name}`);
    },

    unpick: () => {
      state.today.pickedId = null;
      state.history = state.history.filter((h) => h.dayIndex !== state.dayIndex);
      persist();
    },

    'next-day': () => {
      const ate = state.history.find((h) => h.dayIndex === state.dayIndex);
      state.dayIndex += 1;
      state.today = { dayIndex: state.dayIndex, recIds: [], skipped: [], pickedId: null };
      persist();
      window.scrollTo({ top: 0 });
      toast(ate ? `第 ${state.dayIndex + 1} 天：「${ate.mainDish}」今天不会再出现` : `进入第 ${state.dayIndex + 1} 天`);
    },

    reset: () => {
      if (!window.confirm || window.confirm('确定清空偏好和所有记录吗？')) {
        state = Store.reset();
        Object.keys(reasonCache).forEach((k) => delete reasonCache[k]);
        draft = null; parseNote = '';
        view = 'prefs';
      }
    },
  };

  $app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    e.preventDefault();
    const fn = actions[el.dataset.act];
    if (!fn) return;
    // 偏好页的输入框内容在重新渲染前先存下来
    const nl = document.getElementById('nl-input');
    if (nl && draft) draft._text = nl.value;
    await fn(el);
    render();
  });

  render();
})();
