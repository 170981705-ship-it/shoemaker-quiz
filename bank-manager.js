/* ============================================================
 * bank-manager.js — 多题库管理模块
 * 职责：题库的存储/切换/导入/导出/解析
 * 数据全部存在 localStorage，不依赖后端
 * ============================================================ */

var BankManager = (function () {
  'use strict';

  var LS_BANKS = 'shoemaker_quiz_banks_v2';      // 用户导入的题库
  var LS_ACTIVE = 'shoemaker_quiz_active_v2';    // 当前激活题库ID
  var LS_PROGRESS = 'shoemaker_quiz_progress_v2';// 按题库隔离的进度
  var BUILTIN_ID = 'builtin';

  var builtinQuestions = (typeof QUESTION_BANK !== 'undefined') ? QUESTION_BANK : [];
  var listeners = [];

  // ---------- 基础存储 ----------
  function read(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  // ---------- 题库列表 ----------
  function getCustomBanks() {
    return read(LS_BANKS, []);
  }
  function saveCustomBanks(list) {
    return write(LS_BANKS, list);
  }

  // 内置题库（不占 localStorage）
  function builtinBank() {
    return {
      id: BUILTIN_ID,
      name: '制鞋工三级题库',
      desc: '高级工理论考核 · 官方终稿',
      source: 'builtin',
      count: builtinQuestions.length,
      createdAt: 0,
      questions: builtinQuestions
    };
  }

  // 所有可用题库（线上公共题库 + 内置 + 本地导入）
  function listBanks() {
    var list = [builtinBank()];
    var publicBanks = (typeof PUBLIC_BANKS !== 'undefined' && Array.isArray(PUBLIC_BANKS)) ? PUBLIC_BANKS : [];
    publicBanks.forEach(function (b) {
      list.push({
        id: b.id, name: b.name, desc: b.desc || '', source: 'public',
        count: b.count || (b.questions ? b.questions.length : 0),
        createdAt: b.createdAt || 0,
        questions: b.questions || null,
        url: b.url || null
      });
    });
    getCustomBanks().forEach(function (b) {
      list.push({
        id: b.id, name: b.name, desc: b.desc || '', source: 'local',
        count: b.questions ? b.questions.length : 0,
        createdAt: b.createdAt || 0,
        questions: b.questions || []
      });
    });
    return list;
  }

  function getBank(id) {
    var all = listBanks();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  // ---------- 当前激活题库 ----------
  function getActiveId() {
    var id = localStorage.getItem(LS_ACTIVE) || BUILTIN_ID;
    // 激活的题库不存在了则回退到内置
    if (!getBank(id)) { id = BUILTIN_ID; localStorage.setItem(LS_ACTIVE, id); }
    return id;
  }
  function setActiveId(id) {
    if (!getBank(id)) return false;
    localStorage.setItem(LS_ACTIVE, id);
    notify();
    return true;
  }
  function getActiveBank() { return getBank(getActiveId()); }
  function getActiveQuestions() {
    var b = getActiveBank();
    return (b && b.questions) ? b.questions : builtinQuestions;
  }

  // ---------- 进度（按题库隔离） ----------
  function getProgress(bankId) {
    var all = read(LS_PROGRESS, {});
    return all[bankId || getActiveId()] || { done: {}, wrong: {} };
  }
  function saveProgress(progress, bankId) {
    var all = read(LS_PROGRESS, {});
    all[bankId || getActiveId()] = progress;
    return write(LS_PROGRESS, all);
  }

  // ---------- 导入题库 ----------
  function addBank(bank) {
    var list = getCustomBanks();
    var id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    var item = {
      id: id,
      name: bank.name || '未命名题库',
      desc: bank.desc || '',
      createdAt: Date.now(),
      questions: bank.questions || []
    };
    list.push(item);
    if (!saveCustomBanks(list)) return { ok: false, msg: '存储空间不足，题库可能过大。请清理旧题库或减少题目数量。' };
    notify();
    return { ok: true, id: id, count: item.questions.length };
  }

  function deleteBank(id) {
    if (id === BUILTIN_ID) return { ok: false, msg: '内置题库不能删除' };
    var list = getCustomBanks().filter(function (b) { return b.id !== id; });
    if (!saveCustomBanks(list)) return { ok: false, msg: '删除失败' };
    // 清理该题库进度
    var all = read(LS_PROGRESS, {});
    delete all[id];
    write(LS_PROGRESS, all);
    if (getActiveId() === id) localStorage.setItem(LS_ACTIVE, BUILTIN_ID);
    notify();
    return { ok: true };
  }

  function renameBank(id, newName) {
    var list = getCustomBanks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list[i].name = newName; saveCustomBanks(list); notify(); return true; }
    }
    return false;
  }

  // ---------- 导出题库为文件 ----------
  function exportBank(id) {
    var b = getBank(id);
    if (!b || !b.questions) return null;
    var payload = {
      format: 'shoemaker-quiz-bank/v1',
      name: b.name,
      desc: b.desc || '',
      exportedAt: new Date().toISOString(),
      questions: b.questions
    };
    return JSON.stringify(payload, null, 1);
  }

  // ---------- 订阅变更 ----------
  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  // ============================================================
  // 格式解析：把各种输入统一成标准题目数组
  // 标准题目：{t:'judge'|'single'|'multi', n:编号, q:题干, a:答案, o:{A:..}, m:模块}
  // ============================================================

  // 归一化答案符号
  function normAnswer(a, type) {
    if (!a) return '';
    a = String(a).trim().toUpperCase().replace(/[\s、,，;；]/g, '');
    if (type === 'judge') {
      if (a === '√' || a === '对' || a === '正确' || a === 'T' || a === 'TRUE' || a === 'Y' || a === '是' || a === 'A' || a === '1') return '√';
      if (a === '×' || a === '错' || a === '错误' || a === 'X' || a === 'F' || a === 'FALSE' || a === 'N' || a === '否' || a === 'B' || a === '0') return '×';
      return '';
    }
    // 选择题：只保留 A-E
    var cleaned = a.replace(/[^A-E]/g, '');
    // 去重排序
    return cleaned.split('').filter(function (v, i, arr) { return arr.indexOf(v) === i; }).sort().join('');
  }

  function normType(t) {
    if (!t) return '';
    t = String(t).trim();
    if (t.indexOf('判断') >= 0 || t === 'judge' || t === 'tf' || t === '1') return 'judge';
    if (t.indexOf('多选') >= 0 || t === 'multi' || t === 'multiple' || t === '3') return 'multi';
    if (t.indexOf('单选') >= 0 || t === 'single' || t === 'choice' || t === '2') return 'single';
    return '';
  }

  // 校验并规范化一题
  function normalizeQuestion(raw, index) {
    var t = normType(raw.t || raw.type || raw.题型);
    var q = String(raw.q || raw.question || raw.题干 || '').trim();
    var a = normAnswer(raw.a || raw.answer || raw.答案, t);
    var m = String(raw.m || raw.module || raw.模块 || '综合').trim() || '综合';

    if (!t) return null;
    if (!q) return null;

    var o = {};
    var srcO = raw.o || raw.options || {};
    if (srcO && typeof srcO === 'object') {
      Object.keys(srcO).forEach(function (k) {
        var key = String(k).trim().toUpperCase().replace(/[^A-E]/g, '');
        if (key.length === 1) o[key] = String(srcO[k]).trim();
      });
    }
    // 兼容 选项A / A选项 / optA 这类扁平字段
    ['A', 'B', 'C', 'D', 'E'].forEach(function (L) {
      if (o[L]) return;
      var v = raw['选项' + L] || raw['opt' + L] || raw[L] || raw['option' + L];
      if (v) o[L] = String(v).trim();
    });

    if (t === 'judge') {
      if (a !== '√' && a !== '×') return null;
      return { t: t, n: Number(raw.n || raw.no || raw.题号) || (index + 1), q: q, a: a, o: {}, m: m };
    }

    // 选择题必须有答案和至少2个选项
    if (!a) return null;
    var keys = Object.keys(o);
    if (keys.length < 2) return null;
    // 答案字母必须都在选项里
    for (var i = 0; i < a.length; i++) {
      if (!o[a[i]]) return null;
    }
    if (t === 'single' && a.length !== 1) return null;
    if (t === 'multi' && a.length < 2) t = 'single'; // 只有一个答案就当单选
    return { t: t, n: Number(raw.n || raw.no || raw.题号) || (index + 1), q: q, a: a, o: o, m: m };
  }

  // 解析整个题库对象
  function parseBankObject(obj, fallbackName) {
    var arr = null, name = fallbackName || '导入题库', desc = '';
    if (Array.isArray(obj)) arr = obj;
    else if (obj && typeof obj === 'object') {
      if (Array.isArray(obj.questions)) arr = obj.questions;
      else if (Array.isArray(obj.data)) arr = obj.data;
      if (obj.name) name = String(obj.name);
      if (obj.desc) desc = String(obj.desc);
    }
    if (!arr) return { ok: false, msg: '未找到题目数组。JSON 应为数组，或含 questions 字段的对象。' };

    var out = [], skipped = 0;
    arr.forEach(function (raw, i) {
      var q = normalizeQuestion(raw, i);
      if (q) out.push(q); else skipped++;
    });
    if (out.length === 0) return { ok: false, msg: '没有解析出有效题目。请检查字段格式（题型/题干/答案/选项）。' };
    return { ok: true, name: name, desc: desc, questions: out, skipped: skipped };
  }

  // ---------- CSV 解析（支持引号包裹、逗号、换行） ----------
  function parseCSV(text) {
    var rows = [], row = [], cell = '', inQuote = false;
    text = text.replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuote) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') inQuote = false;
        else cell += c;
      } else {
        if (c === '"') inQuote = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c === '\r') { /* skip */ }
        else cell += c;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  // 从表头识别列
  function mapHeader(header) {
    var map = {};
    header.forEach(function (h, i) {
      var s = String(h).trim();
      if (/^(题型|type|类型)$/i.test(s)) map.t = i;
      else if (/^(题号|no|num|编号|id)$/i.test(s)) map.n = i;
      else if (/^(题干|question|题目|问题|q)$/i.test(s)) map.q = i;
      else if (/^(答案|answer|正确|正确答案|a)$/i.test(s)) map.a = i;
      else if (/^(模块|module|分类|类别|章节|m)$/i.test(s)) map.m = i;
      else {
        var mm = s.match(/^(?:选项|opt|option)?\s*([A-E])\s*(?:选项)?$/i);
        if (mm) map['o_' + mm[1].toUpperCase()] = i;
      }
    });
    return map;
  }

  function parseTable(text, fallbackName) {
    var rows = parseCSV(text);
    if (rows.length < 2) return { ok: false, msg: '表格内容为空或只有表头。' };
    var map = mapHeader(rows[0]);
    if (map.q === undefined || map.a === undefined) {
      return { ok: false, msg: '表头需包含「题干」和「答案」两列。当前表头：' + rows[0].join(' / ') };
    }
    var arr = [];
    var typeMap = { 1: 'judge', 2: 'single', 3: 'multi' };
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var raw = {
        t: row[map.t] || '', n: row[map.n] || r,
        q: row[map.q] || '', a: row[map.a] || '', m: row[map.m] || '综合'
      };
      // 没写题型列时，按答案智能推断
      if (!String(raw.t).trim()) {
        var av = String(raw.a).trim();
        raw.t = (av === '√' || av === '×' || /^(对|错|正确|错误)$/.test(av)) ? 'judge'
          : (av.replace(/[^A-E]/gi, '').length > 1 ? 'multi' : 'single');
      }
      ['A', 'B', 'C', 'D', 'E'].forEach(function (L) {
        if (map['o_' + L] !== undefined) raw['选项' + L] = row[map['o_' + L]] || '';
      });
      arr.push(raw);
    }
    return parseBankObject({ name: fallbackName, questions: arr }, fallbackName);
  }

  // ---------- 纯文本智能解析（从 PDF / Word 复制来的题库） ----------
  // 支持：
  //   1.判断题题干（√）
  //   2.单选题题干（A）  /  A.xxx  B.xxx  C.xxx  D.xxx
  //   3.多选题题干（ABC）/  A.xxx  B.xxx ...
  //   支持分节标题「一、判断题」「二、单选题」「三、多选题」
  function parsePlainText(text, fallbackName) {
    text = text.replace(/\r/g, '').replace(/\u00a0/g, ' ');
    // 去掉页码标记与独立页码行
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) {
      return l !== '' && !/^\d{1,3}$/.test(l) && !/^=====\s*PAGE/i.test(l);
    });
    var joined = lines.join('\n');

    // 按分节标题切段
    var sections = [];
    var secRe = /^[一二三四五六七八九十]+[、.．]\s*(判断题|单选题|多选题|单项选择|多项选择)/;
    var cur = null;
    lines.forEach(function (line) {
      var mm = line.match(secRe);
      if (mm) {
        var t = mm[1].indexOf('判断') >= 0 ? 'judge'
          : (mm[1].indexOf('多') >= 0 ? 'multi' : 'single');
        cur = { type: t, lines: [] };
        sections.push(cur);
      } else if (cur) cur.lines.push(line);
    });

    // 没有分节标题：整段按自动推断处理
    if (sections.length === 0) sections = [{ type: null, lines: lines }];

    var results = [];
    sections.forEach(function (sec) {
      // 按题号逐行切分（支持 "206 " 缺点号，排除 "0.4MPa" 这类小数）
      var chunks = [];
      var current = null;
      sec.lines.forEach(function (line) {
        var m = line.match(/^(\d{1,3})[.\s]+(?=\D)/);
        if (m) {
          if (current) chunks.push(current);
          current = { no: Number(m[1]), text: line.slice(m[0].length) };
        } else if (current) {
          current.text += '\n' + line;
        }
      });
      if (current) chunks.push(current);

      chunks.forEach(function (c) {
        var txt = c.text.replace(/\n/g, ' ').trim();
        // 提取答案括号：题干（√/×/ABC）
        var am = txt.match(/[（(]\s*([√×]|[A-Ea-e]{1,5})\s*[）)]/);
        if (!am) return;
        var ansRaw = am[1];
        var question = txt.slice(0, am.index).trim();
        var rest = txt.slice(am.index + am[0].length).trim();

        // 提取选项（不用 lookbehind，兼容老版 iOS Safari / 微信内置浏览器）
        // 允许 A 后缺点号（PDF 排版瑕疵，如 "A 普通剪刀"）
        var opts = {};
        var re = /(^|[\s，,；;])([A-E])(?:[.、．:：]\s*|\s+(?=[^\s]))/g;
        var matches = [], mm2;
        while ((mm2 = re.exec(rest)) !== null) {
          matches.push({ L: mm2[2], pos: mm2.index + mm2[1].length, end: mm2.index + mm2[0].length });
        }
        // 去重：同字母只取第一次出现（防止下一题污染）
        var seen = {};
        matches = matches.filter(function (x) {
          if (seen[x.L]) return false;
          seen[x.L] = true; return true;
        });
        matches.sort(function (a, b) { return a.pos - b.pos; });
        // 只保留字母递增序列（A,B,C,D...），丢弃后面混入的其他题
        var expected = ['A', 'B', 'C', 'D', 'E'], ei = 0;
        for (var k = 0; k < matches.length; k++) {
          if (matches[k].L !== expected[ei]) break;
          var end = (k + 1 < matches.length) ? matches[k + 1].pos : rest.length;
          opts[matches[k].L] = rest.slice(matches[k].end, end).trim();
          ei++;
        }

        var type = sec.type;
        if (!type) {
          type = (ansRaw === '√' || ansRaw === '×') ? 'judge'
            : (ansRaw.replace(/[^A-Ea-e]/g, '').length > 1 ? 'multi' : 'single');
        }
        var a = normAnswer(ansRaw, type);
        if (!a) return;
        if (type === 'judge') {
          results.push({ t: 'judge', n: c.no, q: question, a: a, o: {}, m: '综合' });
        } else if (Object.keys(opts).length >= 2) {
          var valid = a.split('').every(function (L) { return !!opts[L]; });
          if (!valid) return;
          results.push({ t: type, n: c.no, q: question, a: a, o: opts, m: '综合' });
        }
      });
    });

    if (results.length === 0) {
      return { ok: false, msg: '未能从文本中识别出题目。请确认格式为「1.题干（答案）」并含选项行，或改用 Excel/JSON 导入。' };
    }
    return { ok: true, name: fallbackName || '文本导入题库', desc: '从文本智能解析', questions: results, skipped: 0, parsed: true };
  }

  // ---------- 统一入口：根据文件类型解析 ----------
  function parseFile(content, filename, fileType) {
    var name = (filename || '导入题库').replace(/\.(json|csv|txt|xlsx|xls)$/i, '');
    var lower = (filename || '').toLowerCase();

    if (lower.endsWith('.json')) {
      var obj;
      try { obj = JSON.parse(content); }
      catch (e) { return { ok: false, msg: 'JSON 格式错误：' + e.message }; }
      return parseBankObject(obj, name);
    }
    if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
      // 先尝试表格
      var tbl = parseTable(content, name);
      if (tbl.ok) return tbl;
      // 再尝试纯文本
      var txt = parsePlainText(content, name);
      if (txt.ok) return txt;
      return { ok: false, msg: tbl.msg + ' 或 ' + txt.msg };
    }
    return { ok: false, msg: '不支持的文件格式：' + filename };
  }

  // ---------- 统计摘要 ----------
  function summarize(questions) {
    var c = { judge: 0, single: 0, multi: 0 };
    questions.forEach(function (q) { if (c[q.t] !== undefined) c[q.t]++; });
    return { total: questions.length, judge: c.judge, single: c.single, multi: c.multi };
  }

  return {
    BUILTIN_ID: BUILTIN_ID,
    listBanks: listBanks,
    getBank: getBank,
    getActiveId: getActiveId,
    setActiveId: setActiveId,
    getActiveBank: getActiveBank,
    getActiveQuestions: getActiveQuestions,
    getProgress: getProgress,
    saveProgress: saveProgress,
    addBank: addBank,
    deleteBank: deleteBank,
    renameBank: renameBank,
    exportBank: exportBank,
    parseBankObject: parseBankObject,
    parseTable: parseTable,
    parsePlainText: parsePlainText,
    parseFile: parseFile,
    summarize: summarize,
    onChange: onChange,
    normAnswer: normAnswer
  };
})();
