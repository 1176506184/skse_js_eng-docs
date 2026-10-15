(() => {
    const search = document.getElementById('search'), results = document.getElementById('search-results');
    search.addEventListener('input', () => {
        const term = search.value.trim().toLowerCase(); results.replaceChildren(); results.hidden = !term;
        if (!term) return;
        const matches = (window.SKYRIMJS_SEARCH || []).filter(page => (page.title + ' ' + page.text).toLowerCase().includes(term)).slice(0, 10);
        for (const page of matches) { const a = document.createElement('a'); a.href = page.href; a.textContent = page.title; results.append(a); }
        if (!matches.length) { const p = document.createElement('p'); p.textContent = '没有匹配内容'; results.append(p); }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { results.hidden = true; search.blur(); } });
    for (const button of document.querySelectorAll('.copy-code')) button.addEventListener('click', async () => {
        const code = button.closest('.code-block').querySelector('code').textContent;
        try { await navigator.clipboard.writeText(code); button.textContent = '已复制'; }
        catch { button.textContent = '请手动复制'; }
        setTimeout(() => button.textContent = '复制', 1800);
    });
})();
