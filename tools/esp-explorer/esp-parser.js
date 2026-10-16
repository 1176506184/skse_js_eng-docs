/* Skyrim SE plugin reader. No game process, native libraries or network access. */
(function (root) {
    function createEspParser(options = {}) {
        const itemTypes = new Set(['SCRL', 'ARMO', 'BOOK', 'INGR', 'LIGH', 'MISC', 'APPA', 'WEAP', 'AMMO', 'KEYM', 'ALCH', 'SLGM']);
        const animationTypes = new Set(['IDLE', 'AACT', 'IDLM']);
        const hex = (n, width = 8) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(width, '0');
        const bytes = input => input instanceof Uint8Array ? input : new Uint8Array(input);
        const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
        const signature = (data, p) => String.fromCharCode(...data.subarray(p, p + 4));
        const category = type => itemTypes.has(type) ? 'items' : animationTypes.has(type) ? 'animations' : type === 'QUST' ? 'quests' : (type === 'NPC_' || type === 'ACHR') ? 'actors' : 'other';
        const validEvent = name => /^[A-Za-z0-9_.:-]{1,256}$/.test(name);
        function decode(data, encoding = 'auto') {
            const end = data.indexOf(0);
            const slice = end < 0 ? data : data.subarray(0, end);
            if (encoding !== 'auto') return new TextDecoder(encoding).decode(slice);
            try { return new TextDecoder('utf-8', { fatal: true }).decode(slice); }
            catch { return new TextDecoder('windows-1252').decode(slice); }
        }
        function fields(data, callback) {
            const dv = view(data);
            let p = 0, extended = null;
            while (p < data.length) {
                if (p + 6 > data.length) throw new Error('子记录头不完整，位置 ' + hex(p));
                const tag = signature(data, p);
                const length = extended === null ? dv.getUint16(p + 4, true) : extended;
                extended = null;
                if (p + 6 + length > data.length) throw new Error(tag + ' 子记录越界');
                const value = data.subarray(p + 6, p + 6 + length);
                if (tag === 'XXXX') {
                    if (length !== 4) throw new Error('XXXX 扩展长度必须为 4 字节');
                    extended = view(value).getUint32(0, true);
                } else callback(tag, value);
                p += 6 + length;
            }
            if (extended !== null) throw new Error('XXXX 后缺少子记录');
        }
        function parseStringTable(input, filename, encoding = 'auto') {
            const data = bytes(input), dv = view(data);
            if (data.length < 8) throw new Error(filename + ': 字符串表头不完整');
            const count = dv.getUint32(0, true), length = dv.getUint32(4, true);
            const start = 8 + count * 8;
            if (start > data.length || start + length !== data.length) throw new Error(filename + ': 字符串表长度错误');
            const prefixed = /\.(dlstrings|ilstrings)$/i.test(filename);
            const entries = new Map();
            for (let i = 0; i < count; i++) {
                const id = dv.getUint32(8 + i * 8, true), offset = dv.getUint32(12 + i * 8, true);
                let p = start + offset, end;
                if (p >= data.length) throw new Error(filename + ': 字符串偏移越界');
                if (prefixed) {
                    if (p + 4 > data.length) throw new Error(filename + ': 字符串长度不完整');
                    const size = dv.getUint32(p, true); p += 4; end = p + size;
                    if (end > data.length) throw new Error(filename + ': 字符串内容越界');
                } else {
                    end = data.indexOf(0, p);
                    if (end < 0) throw new Error(filename + ': 字符串缺少结束符');
                }
                entries.set(id, decode(data.subarray(p, end), encoding));
            }
            return { filename, kind: filename.split('.').pop().toLowerCase(), entries };
        }
        function scriptNames(data, encoding) {
            const dv = view(data); let p = 0;
            function take(size) { if (size < 0 || p + size > data.length) throw new Error('VMAD 越界'); const at = p; p += size; return at; }
            const u8 = () => dv.getUint8(take(1));
            const u16 = () => dv.getUint16(take(2), true);
            const u32 = () => dv.getUint32(take(4), true);
            const string = () => { const size = u16(); const at = take(size); return decode(data.subarray(at, at + size), encoding); };
            const version = u16(); u16();
            if (version < 2 || version > 5) throw new Error('不支持的 VMAD 版本 ' + version);
            const count = u16(), result = [];
            function value(type) {
                if (type === 0) return;
                if (type === 1) take(8);
                else if (type === 2) string();
                else if (type === 3 || type === 4) take(4);
                else if (type === 5) take(1);
                else if (type >= 11 && type <= 15) {
                    const count = u32();
                    if (type === 12) { if (count > data.length - p) throw new Error('VMAD 数组过长'); for (let j = 0; j < count; j++) string(); }
                    else take(count * (type === 11 ? 8 : type === 15 ? 1 : 4));
                } else throw new Error('不支持的 VMAD 属性类型 ' + type);
            }
            for (let i = 0; i < count; i++) {
                result.push(string()); u8(); const properties = u16();
                for (let j = 0; j < properties; j++) { string(); const type = u8(); u8(); value(type); }
            }
            return result;
        }
        async function inflate(data, expected) {
            if (expected > 64 * 1024 * 1024) throw new Error('单条记录解压大小超过 64 MiB');
            let result;
            if (options.inflate) result = bytes(await options.inflate(data, expected));
            else {
                if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压，请使用新版 Chrome / Edge 或命令行工具');
                const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
                const chunks = []; let total = 0;
                try {
                    for (;;) {
                        const { done, value } = await reader.read(); if (done) break;
                        total += value.length;
                        if (total > expected) { await reader.cancel(); throw new Error('解压数据超过声明长度'); }
                        chunks.push(value);
                    }
                } finally { reader.releaseLock(); }
                result = new Uint8Array(total); let p = 0;
                for (const chunk of chunks) { result.set(chunk, p); p += chunk.length; }
            }
            if (result.length !== expected) throw new Error('解压大小与记录声明不符');
            return result;
        }
        async function parsePlugin(input, config = {}) {
            const data = bytes(input), dv = view(data), filename = config.filename || 'Unknown.esp';
            if (data.length < 24 || signature(data, 0) !== 'TES4') throw new Error('需要 Skyrim SE 的 ESP / ESM / ESL 文件（TES4 文件头）');
            const headerSize = dv.getUint32(4, true);
            if (headerSize > data.length - 24) throw new Error('TES4 文件头越界');
            const flags = dv.getUint32(8, true), localized = !!(flags & 0x80);
            const metadata = { filename, bytes: data.length, flags: hex(flags), localized, light: !!(flags & 0x200), masters: [], author: '', description: '', declaredRecords: 0 };
            const encoding = config.encoding || 'auto';
            fields(data.subarray(24, 24 + headerSize), (tag, value) => {
                if (tag === 'MAST') metadata.masters.push(decode(value, encoding));
                else if (tag === 'CNAM') metadata.author = decode(value, encoding);
                else if (tag === 'SNAM') metadata.description = decode(value, encoding);
                else if (tag === 'HEDR' && value.length >= 12) { metadata.version = view(value).getFloat32(0, true); metadata.declaredRecords = view(value).getUint32(4, true); }
            });
            const tables = config.tables || [], records = [], warnings = [], counts = {};
            let missingStrings = 0, skipped = 0, warningCount = 0;
            function warn(message) { warningCount++; if (warnings.length < 200) warnings.push(message); }
            function text(value, kind = 'strings') {
                if (!localized) return decode(value, encoding);
                if (value.length !== 4) { warn('本地化文本字段长度异常'); return '[本地化字段异常]'; }
                const id = view(value).getUint32(0, true);
                if (!id) return '';
                const table = tables.find(table => table.kind === kind && table.entries.has(id));
                if (table) return table.entries.get(id);
                missingStrings++; return '[缺少文本 ' + hex(id) + ']';
            }
            const ends = [data.length]; let p = 24 + headerSize, groups = 0;
            while (p < data.length) {
                while (ends.length > 1 && p === ends[ends.length - 1]) ends.pop();
                const end = ends[ends.length - 1];
                if (p + 24 > end) throw new Error('记录头超出分组边界：' + hex(p));
                const type = signature(data, p), size = dv.getUint32(p + 4, true);
                if (type === 'GRUP') {
                    if (size < 24 || p + size > end || ends.length >= 64) throw new Error('GRUP 分组长度或深度错误：' + hex(p));
                    ends.push(p + size); p += 24; groups++; continue;
                }
                if (!/^[A-Z0-9_]{4}$/.test(type) || p + 24 + size > end) throw new Error('记录类型或长度错误：' + hex(p));
                const recordFlags = dv.getUint32(p + 8, true), raw = dv.getUint32(p + 12, true), index = raw >>> 24;
                const origin = index < metadata.masters.length ? metadata.masters[index] : index === metadata.masters.length ? filename : null;
                const row = { signature: type, category: category(type), editorId: '', name: '', fileFormId: hex(raw), localFormId: hex(raw & 0xFFFFFF, 6), originPlugin: origin,
                    override: index < metadata.masters.length, deleted: !!(recordFlags & 0x20), compressed: !!(recordFlags & 0x40000), offset: p, size, flags: hex(recordFlags) };
                let payload = data.subarray(p + 24, p + 24 + size);
                try {
                    if (row.compressed) {
                        if (payload.length < 4) throw new Error('压缩记录头不完整');
                        payload = await inflate(payload.subarray(4), view(payload).getUint32(0, true));
                    }
                    const tags = new Set(), details = {};
                    let stage = null, entry = null, objective = null;
                    fields(payload, (tag, value) => {
                        tags.add(tag); const v = view(value);
                        if (tag === 'EDID' && !row.editorId) row.editorId = decode(value, encoding);
                        if (tag === 'FULL' && !row.name) row.name = text(value);
                        if (type === 'ACHR' && tag === 'NAME' && value.length === 4) details.baseFileFormId = hex(v.getUint32(0, true));
                        if (tag === 'VMAD') {
                            try { details.scripts = scriptNames(value, encoding); }
                            catch (error) { details.scriptWarning = error.message; warn(type + ' ' + row.fileFormId + ': ' + error.message); }
                        }
                        if (type === 'IDLE') {
                            if (tag === 'ENAM') details.animationEvent = decode(value, encoding);
                            if (tag === 'DNAM') details.animationFile = decode(value, encoding);
                            if (tag === 'ANAM' && value.length >= 8) details.relatedFileIds = [hex(v.getUint32(0, true)), hex(v.getUint32(4, true))];
                        }
                        if (type === 'QUST') {
                            if (tag === 'DNAM' && value.length >= 12) { details.questFlags = hex(v.getUint16(0, true), 4); details.priority = v.getUint8(2); details.questType = v.getUint32(8, true); }
                            if (tag === 'INDX' && value.length >= 4) {
                                stage = { index: v.getUint16(0, true), flags: v.getUint8(2), entries: [] };
                                (details.stages ||= []).push(stage); entry = null; objective = null;
                            }
                            if (tag === 'QSDT' && stage && value.length) { entry = { flags: value[0], text: '' }; stage.entries.push(entry); }
                            if (tag === 'CNAM' && entry) entry.text = text(value, 'dlstrings');
                            if (tag === 'QOBJ' && value.length >= 2) { objective = { index: v.getUint16(0, true), text: '' }; (details.objectives ||= []).push(objective); stage = null; entry = null; }
                            if (tag === 'NNAM' && objective) objective.text = text(value);
                            if (tag === 'ALST' || tag === 'ALLS' || tag === 'ANAM') { stage = null; entry = null; objective = null; }
                        }
                    });
                    row.fields = [...tags].join(', ');
                    if (Object.keys(details).length) row.details = details;
                } catch (error) { row.parseError = error.message; skipped++; warn(type + ' ' + row.fileFormId + ': ' + error.message); }
                if (!origin) warn(type + ' ' + row.fileFormId + ': 无法确定原始插件');
                records.push(row); counts[type] = (counts[type] || 0) + 1; p += 24 + size;
                if (records.length % 2048 === 0) config.onProgress?.({ bytes: p, total: data.length, records: records.length });
            }
            if (missingStrings) warn('有 ' + missingStrings + ' 个文本字段缺少对应字符串表；请选择同语言的 STRINGS / DLSTRINGS / ILSTRINGS 文件');
            config.onProgress?.({ bytes: data.length, total: data.length, records: records.length });
            return { format: 'SkyrimJS.PluginExplorer.v1', metadata: { ...metadata, groups, records: records.length, skipped, missingStrings, warningCount }, counts, records, warnings };
        }
        function animationCandidates(source, filename) {
            const result = [], seen = new Set();
            function add(event, sourceType, location) {
                if (!validEvent(event) || /\.hkx$/i.test(event)) return;
                const key = event + ':' + sourceType + ':' + location;
                if (seen.has(key)) return; seen.add(key);
                result.push({ event, source: filename, sourceType, location, verifiedInGame: false });
            }
            if (/\.json$/i.test(filename)) {
                function walk(value, path, animationContext, depth = 0) {
                    if (depth > 64) throw new Error('JSON 嵌套超过 64 层');
                    if (typeof value === 'string' && animationContext) add(value, 'JSON 候选', path);
                    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, path + '[' + i + ']', animationContext, depth + 1));
                    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, path + '.' + k, animationContext || /anim|idle|event/i.test(k), depth + 1));
                }
                walk(JSON.parse(source), '$', false);
            } else if (/\.psc$/i.test(filename)) {
                // Strip Papyrus comments while preserving line numbers and quoted strings.
                let clean = '', quote = false, block = false, line = false;
                for (let i = 0; i < source.length; i++) {
                    const c = source[i], next = source[i + 1];
                    if (block) { if (c === '/' && next === ';') { block = false; clean += '  '; i++; } else clean += c === '\n' ? '\n' : ' '; }
                    else if (line) { clean += c === '\n' ? '\n' : ' '; if (c === '\n') line = false; }
                    else if (!quote && c === ';') { block = next === '/'; line = !block; clean += ' '; if (block) { clean += ' '; i++; } }
                    else { clean += c; if (quote && c === '\\' && next) { clean += next; i++; } else if (c === '"') quote = !quote; }
                }
                const pattern = /\bDebug\s*\.\s*SendAnimationEvent\s*\([^,\n]*,\s*"([A-Za-z0-9_.:-]+)"\s*\)/gi;
                for (const match of clean.matchAll(pattern)) add(match[1], 'Papyrus 字面量', '行 ' + (clean.slice(0, match.index).split('\n').length));
            } else {
                source.split(/\r?\n/).forEach((line, i) => {
                    const match = /^\s*(?:b|s)\s+(?:-\S+\s+)*([A-Za-z0-9_.:-]+)\s+(\S+\.hkx)(?:\s|$)/i.exec(line);
                    if (match) add(match[1], 'FNIS 列表', '行 ' + (i + 1) + ': ' + match[2]);
                });
            }
            return result;
        }
        function snippet(row, plugin) {
            const event = row.event || row.details?.animationEvent;
            const owner = row.originPlugin || (row.event ? plugin : null);
            if (!owner || row.deleted || row.parseError) return '// 原始插件未知、记录已删除或解析失败，暂不生成调用代码。';
            if (row.signature === 'ACHR') return [
                'skse.onMounted(() => {',
                '    const hero = skse.getActor({ plugin: ' + JSON.stringify(owner) + ', referenceId: ' + JSON.stringify(row.localFormId) + ' });',
                '    if (!hero) return;',
                '    // 获取已有角色；需要传送时再调用，不会生成新角色。',
                '    // hero.moveTo(skse.player[0]);',
                '});'
            ].join('\n');
            const lines = ['import mod from ' + JSON.stringify('@skse/' + owner) + ';', '', 'skse.onMounted(() => {', '    if (!mod.loaded) return;'];
            if (event && validEvent(event)) lines.push('    const action = mod.getStatus(' + JSON.stringify(event) + ');', '    if (action) skse.player[0].setStatus(action);');
            else {
                lines.push('    const form = mod.getForm(' + JSON.stringify(row.localFormId) + ');');
                if (row.category === 'items') lines.push('    if (form) skse.player[0].addItem(form, 1);');
                else if (row.signature === 'NPC_') lines.push('    if (form) skse.new({ formId: form.formId });');
                else lines.push('    // 当前只查询记录；启动任务等操作需要额外的运行时 API。');
            }
            lines.push('});'); return lines.join('\n');
        }
        return { parsePlugin, parseStringTable, animationCandidates, snippet, decode, hex };
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { createEspParser };
    else root.createEspParser = createEspParser;
})(globalThis);
