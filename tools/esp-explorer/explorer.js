'use strict';
(() => {
    const $ = id => document.getElementById(id);
    const api = createEspParser();
    const categories = [['all', '全部记录'], ['items', '道具与装备'], ['animations', '动作与事件'], ['quests', '任务'], ['actors', 'NPC'], ['other', '其他记录']];
    const state = { plugin: null, assets: new Map(), result: null, events: [], extraWarnings: [], all: [], filtered: [], category: 'all', page: 0, selected: null, worker: null, generation: 0 };
    const pageSize = 80;
    const number = value => value.toLocaleString('zh-CN');
    const size = value => (value / 1024 / 1024).toFixed(2) + ' MiB';
    function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
    function status(message, error = false) { $('status').textContent = message; $('status').className = 'status' + (error ? ' error' : ''); }
    function counts(category) { return category === 'all' ? state.all.length : state.all.filter(row => row.category === category).length; }
    function drawCategories() {
        $('categories').replaceChildren(...categories.map(([key, title]) => {
            const button = node('button', title, state.category === key ? 'active' : '');
            button.append(node('span', number(counts(key))));
            button.onclick = () => { state.category = key; state.page = 0; drawCategories(); filter(); };
            return button;
        }));
        $('stats').replaceChildren(...[['items', '道具记录'], ['animations', '动作 / 配置事件'], ['quests', '任务记录'], ['all', '记录总数']].map(([key, title]) => {
            const div = node('div', undefined, 'stat'); div.append(node('span', title), node('strong', number(counts(key)))); return div;
        }));
    }
    function filter() {
        const needle = $('search').value.trim().toLowerCase(), type = $('signature').value;
        state.filtered = state.all.filter(row =>
            (state.category === 'all' || row.category === state.category) && (!type || row.signature === type) &&
            ($('showDeleted').checked || !row.deleted) &&
            (!$('ownOnly').checked || (!row.override && row.originPlugin === state.result?.metadata.filename)) &&
            (!needle || [row.signature, row.editorId, row.name, row.fileFormId, row.localFormId, row.originPlugin, row.event, row.details?.animationEvent, row.source].some(v => String(v || '').toLowerCase().includes(needle))));
        state.page = Math.min(state.page, Math.max(0, Math.ceil(state.filtered.length / pageSize) - 1));
        renderRows();
    }
    function renderRows() {
        const start = state.page * pageSize;
        $('rows').replaceChildren(...state.filtered.slice(start, start + pageSize).map(row => {
            const tr = node('tr', undefined, row === state.selected ? 'selected' : ''); tr.tabIndex = 0;
            tr.setAttribute('aria-selected', String(row === state.selected));
            const type = node('td'); type.append(node('span', row.signature, 'badge'));
            const title = node('td'); title.append(node('strong', row.name || row.event || row.editorId || '（无名称）'));
            title.append(node('small', row.editorId || row.details?.animationEvent || row.source || row.fields || ''));
            if (row.deleted) title.append(node('small', '已删除'));
            if (row.parseError) title.append(node('small', '部分字段解析失败'));
            const id = node('td', row.localFormId || '—', 'id');
            const owner = node('td', row.originPlugin || (row.event ? '配置候选' : '未知'));
            if (row.override) owner.append(node('small', '覆盖记录'));
            tr.append(type, title, id, owner);
            tr.onclick = () => { state.selected = row; showDetail(row); renderRows(); };
            tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); } };
            return tr;
        }));
        const pages = Math.ceil(state.filtered.length / pageSize);
        $('empty').hidden = state.filtered.length > 0;
        if (state.result && !state.filtered.length) {
            $('empty').replaceChildren(node('div', '◇', 'empty-symbol'), node('h2', '没有匹配的记录'), node('p', '可以切换分类、清空搜索或显示已删除记录。ESP 中没有 Idle 记录时，可补充动作配置。'));
        }
        $('resultCount').textContent = number(state.filtered.length) + ' 条结果';
        $('pageInfo').textContent = '第 ' + (pages ? state.page + 1 : 0) + ' / ' + pages + ' 页';
        $('previous').disabled = state.page === 0; $('next').disabled = state.page + 1 >= pages;
        $('exportCsv').disabled = $('exportJson').disabled = !state.result;
    }
    function showDetail(row) {
        const detail = $('detail'); detail.replaceChildren(node('h2', row.name || row.editorId || row.event || row.signature, 'detail-title'));
        const dl = node('dl');
        const add = (label, value) => { if (value !== undefined && value !== null && value !== '') dl.append(node('dt', label), node('dd', String(value))); };
        add('记录类型', row.signature); add('Editor ID', row.editorId); add('内部 ID', row.localFormId);
        add('文件 ID', row.fileFormId); add('原始插件', row.originPlugin); add('当前插件', state.result.metadata.filename);
        add('覆盖记录', row.event ? undefined : row.override ? '是' : '否'); add('记录状态', row.deleted ? '已删除' : row.event ? '外部配置候选' : '有效记录');
        add('文件偏移', row.offset === undefined ? undefined : api.hex(row.offset)); add('记录大小', row.size === undefined ? undefined : row.size + ' 字节');
        add('压缩记录', row.event ? undefined : row.compressed ? '是' : '否'); add('来源', row.source); add('来源位置', row.location); add('提取方式', row.sourceType);
        add('动画事件', row.event || row.details?.animationEvent); add('动作文件', row.details?.animationFile);
        add('脚本', row.details?.scripts?.join(', ')); add('子记录', row.fields); detail.append(dl);
        if (row.parseError) detail.append(node('p', row.parseError, 'notice'));
        if (row.details?.scriptWarning) detail.append(node('p', row.details.scriptWarning, 'notice'));
        if (row.category === 'animations') detail.append(node('p', '事件名与 Editor ID 含义不同。此处只显示记录或配置值，不代表动作已安装或可播放。', 'notice'));
        if (row.signature === 'QUST') {
            detail.append(node('p', '任务 ID 与阶段来自文件定义，当前 SkyrimJS 尚未提供启动任务或设置阶段的接口。', 'notice'));
            if (row.details?.stages?.length) {
                detail.append(node('h3', '任务阶段 · ' + row.details.stages.length));
                const ul = node('ul');
                row.details.stages.forEach(stage => { ul.append(node('li', '[' + stage.index + '] ' + (stage.entries.map(entry => entry.text).filter(Boolean).join(' / ') || '（无日志文本）'))); }); detail.append(ul);
            }
            if (row.details?.objectives?.length) {
                detail.append(node('h3', '任务目标'));
                const ul = node('ul'); row.details.objectives.forEach(objective => ul.append(node('li', '[' + objective.index + '] ' + objective.text))); detail.append(ul);
            }
        }
        $('code').textContent = api.snippet(row, state.result.metadata.filename);
        $('copyId').disabled = !row.localFormId; $('copyCode').disabled = false;
    }
    async function copy(text) {
        try { await navigator.clipboard.writeText(text); }
        catch {
            const field = node('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field);
            field.select(); const copied = document.execCommand('copy'); field.remove(); if (!copied) { status('复制失败，请手动选中代码复制。', true); return; }
        }
        status('已复制到剪贴板。');
    }
    function download(filename, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type })); const a = node('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    $('exportJson').onclick = () => download(state.plugin.name + '.json', JSON.stringify({ ...state.result, records: state.filtered.filter(row => !row.event), animationCandidates: state.filtered.filter(row => row.event), warnings: [...state.result.warnings, ...state.extraWarnings], exportFilter: { category: state.category, search: $('search').value, type: $('signature').value } }, null, 2), 'application/json');
    $('exportCsv').onclick = () => {
        const headers = ['type', 'name', 'editorId', 'localFormId', 'fileFormId', 'originPlugin', 'override', 'deleted', 'animationEvent', 'animationFile', 'source', 'questStages', 'parseError'];
        // Prevent a name from becoming a spreadsheet formula when CSV is opened.
        const cell = value => { let s = String(value ?? ''); if (/^[=+@-]/.test(s.trimStart())) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
        const lines = state.filtered.map(row => [row.signature, row.name, row.editorId, row.localFormId, row.fileFormId, row.originPlugin, row.override, row.deleted, row.event || row.details?.animationEvent, row.details?.animationFile, row.source, row.details?.stages?.map(stage => stage.index).join(';'), row.parseError].map(cell).join(','));
        download(state.plugin.name + '.csv', '\uFEFF' + [headers.join(','), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
    };
    $('copyId').onclick = () => copy(state.selected?.localFormId || ''); $('copyCode').onclick = () => copy($('code').textContent);
    $('previous').onclick = () => { state.page--; renderRows(); }; $('next').onclick = () => { state.page++; renderRows(); };
    let searchTimer;
    $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 0; filter(); }, 120); };
    for (const id of ['signature', 'ownOnly', 'showDeleted']) $(id).onchange = () => { state.page = 0; filter(); };
    $('encoding').onchange = () => load(); $('language').onchange = () => load(false);
    function updateLanguages() {
        const stem = state.plugin.name.replace(/\.(esp|esm|esl)$/i, '').toLowerCase(), languages = new Set();
        for (const file of state.assets.values()) {
            const name = file.name.toLowerCase();
            if (name.startsWith(stem + '_') && /\.(strings|dlstrings|ilstrings)$/.test(name)) languages.add(name.slice(stem.length + 1).replace(/\.(strings|dlstrings|ilstrings)$/, ''));
        }
        const previous = $('language').value;
        $('language').replaceChildren(...[...languages].sort().map(language => { const option = node('option', language); option.value = language; return option; }));
        $('language').hidden = languages.size === 0;
        if (languages.has(previous)) $('language').value = previous;
        else if (languages.has('english')) $('language').value = 'english';
    }
    async function load(refreshLanguages = true) {
        if (!state.plugin) return;
        const generation = ++state.generation;
        if (state.worker) { state.worker.terminate(); state.worker = null; }
        if (refreshLanguages) updateLanguages();
        state.result = null; state.events = []; state.extraWarnings = []; state.all = []; state.filtered = []; state.selected = null; state.page = 0;
        $('detail').replaceChildren(node('p', '解析中…', 'muted')); $('code').textContent = '// 正在读取插件'; $('copyId').disabled = $('copyCode').disabled = true;
        drawCategories(); renderRows(); status('正在读取 ' + state.plugin.name + '…'); $('progressTrack').hidden = false; $('progress').style.width = '0%';
        try {
            if (state.plugin.size > 768 * 1024 * 1024) throw new Error('浏览器版单文件限制为 768 MiB，请使用命令行版解析更大的文件');
            const stem = state.plugin.name.replace(/\.(esp|esm|esl)$/i, '').toLowerCase(), language = $('language').value;
            const tables = [], sources = [], warnings = []; let textBytes = 0;
            for (const file of state.assets.values()) {
                if (/\.(strings|dlstrings|ilstrings)$/i.test(file.name)) {
                    if (file.name.toLowerCase().replace(/\.(strings|dlstrings|ilstrings)$/, '') !== stem + '_' + language) continue;
                    if (file.size > 64 * 1024 * 1024) { warnings.push(file.name + ': 字符串表超过 64 MiB，已跳过'); continue; }
                    tables.push({ filename: file.name, buffer: await file.arrayBuffer() });
                } else if (/\.(txt|json|psc)$/i.test(file.name)) {
                    if (sources.length >= 256 || textBytes + file.size > 64 * 1024 * 1024 || file.size > 8 * 1024 * 1024) { warnings.push(file.name + ': 配置大小或数量超限，已跳过'); continue; }
                    textBytes += file.size; sources.push({ filename: file.webkitRelativePath || file.name, text: await file.text() });
                }
            }
            const buffer = await state.plugin.arrayBuffer();
            if (generation !== state.generation) return;
            const workerCode = 'const createEspParser = ' + createEspParser.toString() + ';(' + workerMain.toString() + ')();';
            const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
            const worker = new Worker(url); URL.revokeObjectURL(url); state.worker = worker;
            worker.onmessage = e => {
                if (generation !== state.generation) return;
                if (e.data.progress) { const progress = e.data.progress; $('progress').style.width = (progress.bytes / progress.total * 100) + '%'; status('正在解析 ' + state.plugin.name + ' · 已读取 ' + number(progress.records) + ' 条记录'); }
                else if (e.data.error) { worker.terminate(); state.worker = null; $('progressTrack').hidden = true; status(e.data.error, true); }
                else { worker.terminate(); state.worker = null; complete(e.data.result, e.data.events, [...warnings, ...e.data.warnings]); }
            };
            worker.onerror = e => { if (generation !== state.generation) return; worker.terminate(); state.worker = null; $('progressTrack').hidden = true; status('解析线程失败：' + (e.message || '请使用新版 Chrome / Edge 或命令行版'), true); };
            worker.postMessage({ buffer, filename: state.plugin.name, encoding: $('encoding').value, tables, sources }, [buffer, ...tables.map(table => table.buffer)]);
        } catch (error) { if (generation === state.generation) { $('progressTrack').hidden = true; status(error.message, true); } }
    }
    function workerMain() {
        self.onmessage = async e => {
            try {
                const api = createEspParser(), { buffer, filename, encoding, sources } = e.data;
                const tables = [], warnings = [], events = [];
                for (const table of e.data.tables) {
                    try { tables.push(api.parseStringTable(table.buffer, table.filename, encoding)); }
                    catch (error) { warnings.push(error.message); }
                }
                const result = await api.parsePlugin(buffer, { filename, encoding, tables, onProgress: progress => self.postMessage({ progress }) });
                for (const source of sources) {
                    try { events.push(...api.animationCandidates(source.text, source.filename)); }
                    catch (error) { warnings.push(source.filename + ': ' + error.message); }
                }
                self.postMessage({ result, events, warnings });
            } catch (error) { self.postMessage({ error: error.message }); }
        };
    }
    function complete(result, events, extraWarnings) {
        state.result = result; state.events = events; state.extraWarnings = extraWarnings;
        state.all = [...result.records, ...events.map(event => ({ ...event, signature: 'EVENT', category: 'animations', name: event.event }))];
        const meta = result.metadata;
        $('fileName').textContent = meta.filename;
        $('fileMeta').textContent = size(meta.bytes) + ' · ' + (meta.light ? '轻量插件' : '普通插件') + ' · ' + meta.masters.length + ' 个 Master · ' + (meta.localized ? '本地化文本' : '内嵌文本');
        $('signature').replaceChildren(node('option', '所有记录类型'), ...[...new Set(state.all.map(row => row.signature))].sort().map(type => { const option = node('option', type); option.value = type; return option; })); $('signature').firstChild.value = '';
        const diagnostics = [...result.warnings, ...extraWarnings];
        $('warningCount').textContent = diagnostics.length ? '(' + (meta.warningCount + extraWarnings.length) + ' 条提示)' : '';
        const masterText = node('p', 'Master 顺序：' + (meta.masters.join(' → ') || '无') + ' → ' + meta.filename);
        const notes = $('notes'); while (notes.children.length > 3) notes.lastChild.remove(); notes.append(masterText);
        if (diagnostics.length) notes.append(node('p', diagnostics.slice(0, 200).join('\n'), 'diagnostic'));
        $('progressTrack').hidden = true;
        status('解析完成 · ' + number(meta.records) + ' 条文件记录 · ' + events.length + ' 条外部动作引用' + (meta.skipped ? ' · ' + meta.skipped + ' 条记录存在字段错误，请查看诊断' : ''));
        drawCategories(); filter();
    }
    function assets(files) { for (const file of files) if (/\.(strings|dlstrings|ilstrings|txt|json|psc)$/i.test(file.name)) state.assets.set(file.webkitRelativePath || file.name, file); }
    $('pluginInput').onchange = e => { if (e.target.files[0]) { state.plugin = e.target.files[0]; $('pluginSelect').hidden = true; state.assets.clear(); load(); } };
    $('assetInput').onchange = e => { assets(e.target.files); load(); };
    $('folderInput').onchange = e => {
        const files = [...e.target.files], plugins = files.filter(file => /\.(esp|esm|esl)$/i.test(file.name));
        if (!plugins.length) { status('该文件夹中没有 ESP / ESM / ESL。', true); return; }
        state.assets.clear(); assets(files); $('pluginSelect').replaceChildren(...plugins.map((file, index) => { const option = node('option', file.webkitRelativePath || file.name); option.value = String(index); return option; }));
        $('pluginSelect').hidden = plugins.length < 2;
        $('pluginSelect').onchange = () => { state.plugin = plugins[Number($('pluginSelect').value)]; load(); };
        state.plugin = plugins[0]; load();
    };
    document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
    document.addEventListener('drop', e => {
        e.preventDefault(); document.body.classList.remove('dragging'); const files = [...e.dataTransfer.files];
        const plugin = files.find(file => /\.(esp|esm|esl)$/i.test(file.name));
        if (plugin) { state.plugin = plugin; state.assets.clear(); $('pluginSelect').hidden = true; }
        assets(files); if (state.plugin) load(); else status('请先选择一个 ESP / ESM / ESL 文件。', true);
    });
    drawCategories(); renderRows();
})();
