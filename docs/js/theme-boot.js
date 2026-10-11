// 主題要在畫面出現前就套用，避免閃一下（獨立檔案而不是寫在 index.html 裡，才能用嚴格的內容安全政策 CSP）
(function () {
  try {
    var t = localStorage.getItem('wb.theme') || 'light'; // 預設淺色
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
