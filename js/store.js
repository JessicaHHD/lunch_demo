/**
 * 本地存储：偏好、模拟日期、点餐历史都存在浏览器 localStorage
 * 以后接入真实账号时，只需要把 load/save 换成接口请求
 */
(function () {
  const KEY = 'lunchpal_demo_v1';

  const DEFAULT_PREFS = {
    flavors: [],
    avoid: [],
    noFried: true,
    lowOil: true,
    wantStaple: true,
    avoidSameIngredient: false,
  };

  function fresh() {
    return {
      prefs: null,                       // null 表示首次使用，先进入偏好设置
      baseDate: new Date().toISOString().slice(0, 10),
      dayIndex: 0,                       // 模拟的第几个工作日（从 0 开始）
      history: [],                       // [{dayIndex, dishId, name, shop, mainDish, mainIngredient, price}]
      today: { dayIndex: 0, recIds: [], skipped: [], pickedId: null },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return fresh();
      return Object.assign(fresh(), JSON.parse(raw));
    } catch (e) {
      return fresh();
    }
  }

  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式等情况下忽略 */ }
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    return fresh();
  }

  window.LunchStore = { load, save, reset, DEFAULT_PREFS };
})();
