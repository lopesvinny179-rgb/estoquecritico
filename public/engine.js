// Motor do Estoque Crítico: leitura de xlsx/xlsm em streaming, cálculo das dinâmicas e geração do xlsx final.
(function (root) {
  'use strict';
  const fflate = root.fflate;

  // ---------- ZIP (acesso aleatório ao arquivo, sem carregar tudo na memória) ----------
  async function readBytes(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function openZip(blob) {
    const size = blob.size;
    const tailLen = Math.min(size, 65557);
    const tail = await readBytes(blob, size - tailLen, size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('O arquivo não parece ser um Excel (.xlsx/.xlsm). Se for .xls antigo, salve como .xlsx.');
    let cdCount = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOff = u32(tail, eocd + 16);
    // ZIP64
    if (cdOff === 0xffffffff || cdCount === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
        const z64off = Number(new DataView(tail.buffer, tail.byteOffset + loc + 8, 8).getBigUint64(0, true));
        const z = await readBytes(blob, z64off, z64off + 56);
        const dv = new DataView(z.buffer, z.byteOffset, 56);
        cdCount = Number(dv.getBigUint64(32, true));
        cdSize = Number(dv.getBigUint64(40, true));
        cdOff = Number(dv.getBigUint64(48, true));
      }
    }
    const cd = await readBytes(blob, cdOff, cdOff + cdSize);
    const entries = {};
    let p = 0;
    const dec = new TextDecoder();
    for (let i = 0; i < cdCount && p < cd.length; i++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const method = u16(cd, p + 10);
      let comp = u32(cd, p + 20), uncomp = u32(cd, p + 24);
      const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
      let off = u32(cd, p + 42);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
      // extra ZIP64
      let x = p + 46 + nlen; const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = u16(cd, x), sz = u16(cd, x + 2);
        if (id === 1) {
          const dv = new DataView(cd.buffer, cd.byteOffset + x + 4, sz);
          let q = 0;
          if (uncomp === 0xffffffff) { uncomp = Number(dv.getBigUint64(q, true)); q += 8; }
          if (comp === 0xffffffff) { comp = Number(dv.getBigUint64(q, true)); q += 8; }
          if (off === 0xffffffff) { off = Number(dv.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + sz;
      }
      entries[name] = { method, comp, uncomp, off };
      p += 46 + nlen + xlen + clen;
    }
    return { blob, entries };
  }

  // Lê uma entrada em pedaços de texto (UTF-8), chamando onText(str) por pedaço.
  async function streamEntry(zip, name, onText, onProgress) {
    const e = zip.entries[name];
    if (!e) throw new Error('Parte interna não encontrada: ' + name);
    const lh = await readBytes(zip.blob, e.off, e.off + 30);
    const start = e.off + 30 + u16(lh, 26) + u16(lh, 28);
    if (e.method !== 8 && e.method !== 0) throw new Error('Compressão não suportada em ' + name);
    // Caminho rápido: descompressão nativa do navegador
    if (typeof DecompressionStream !== 'undefined' && typeof TextDecoderStream !== 'undefined' && zip.blob.slice(0, 0).stream) {
      let read = 0; const total = e.uncomp || 1;
      let stream = zip.blob.slice(start, start + e.comp).stream();
      if (e.method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.pipeThrough(new TextDecoderStream('utf-8')).getReader();
      let parts = [], len = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (value) { parts.push(value); len += value.length; read += value.length; }
        if (len >= 4194304 || (done && len)) {
          const s = parts.length === 1 ? parts[0] : parts.join(''); parts = []; len = 0;
          await onText(s);
          if (onProgress) onProgress(Math.min(1, read / total));
        }
        if (done) break;
      }
      return;
    }
    const td = new TextDecoder('utf-8');
    const CH = 4 * 1024 * 1024;
    let pending = [];
    const flush = (chunk, final) => { const s = td.decode(chunk, { stream: !final }); if (s) pending.push(s); };
    let inf = null;
    if (e.method === 8) inf = new fflate.Inflate((chunk, final) => flush(chunk, final));
    for (let pos = 0; pos < e.comp; pos += CH) {
      const end = Math.min(e.comp, pos + CH);
      const buf = await readBytes(zip.blob, start + pos, start + end);
      if (inf) inf.push(buf, end >= e.comp); else flush(buf, end >= e.comp);
      if (pending.length) { const s = pending.join(''); pending = []; await onText(s); }
      if (onProgress) onProgress(end / e.comp);
    }
    if (pending.length) { await onText(pending.join('')); }
  }
  async function readEntryText(zip, name) {
    const parts = []; await streamEntry(zip, name, s => { parts.push(s); }); return parts.join('');
  }

  // ---------- XML helpers ----------
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unesc(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, g) => {
      if (g[0] === '#') return String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
      return ENT[g] != null ? ENT[g] : m;
    });
  }
  function attr(tag, name) {
    const m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? unesc(m[1]) : null;
  }
  function textOfSi(si) {
    // ignora textos fonéticos (rPh)
    si = si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g; let m;
    while ((m = re.exec(si))) out += m[1] ? unesc(m[1]) : '';
    return out;
  }
  function colIndex(ref) {
    let n = 0, i = 0;
    for (; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); }
    return n - 1;
  }
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  async function workbookSheets(zip) {
    const wb = await readEntryText(zip, 'xl/workbook.xml');
    const relsName = 'xl/_rels/workbook.xml.rels';
    const rels = zip.entries[relsName] ? await readEntryText(zip, relsName) : '';
    const relMap = {};
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attr(m[0], 'Id'), t = attr(m[0], 'Target');
      if (id && t) relMap[id] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }
    const sheets = [];
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id') || attr(m[0], 'id');
      sheets.push({ name, path: relMap[rid], state: attr(m[0], 'state') });
    }
    return sheets;
  }

  async function loadSharedStrings(zip, progress) {
    const name = Object.keys(zip.entries).find(n => /^xl\/sharedStrings\.xml$/i.test(n));
    const ss = [];
    if (!name) return ss;
    let buf = '';
    await streamEntry(zip, name, s => {
      buf += s;
      let last = 0; const re = /<si>([\s\S]*?)<\/si>|<si\/>/g; let m;
      while ((m = re.exec(buf))) { ss.push(m[1] != null ? textOfSi(m[1]) : ''); last = re.lastIndex; }
      buf = buf.slice(last);
      if (progress) progress(ss.length);
    });
    return ss;
  }

  // Percorre as linhas de uma aba. onRow(rowNumber, cells[]) com valores já convertidos (string | number | bool | null)
  // Varredura por índices (sem regex por célula). opts.want: colunas necessárias (definido após o cabeçalho).
  async function readSheetRows(zip, sheetPath, ss, onRow, opts) {
    opts = opts || {};
    let buf = ''; let rowAuto = 0; let stop = false;
    await streamEntry(zip, sheetPath, async s => {
      if (stop) return;
      buf = buf.length ? buf + s : s;
      let p = 0;
      const maxCol = opts.maxCol || 200, want = opts.want || null;
      for (;;) {
        const rs = buf.indexOf('<row', p); if (rs < 0) { p = buf.length > 8 ? Math.max(p, buf.length - 8) : p; break; }
        const tagEnd = buf.indexOf('>', rs); if (tagEnd < 0) { p = rs; break; }
        let r;
        const ri = buf.indexOf(' r="', rs);
        if (ri >= 0 && ri < tagEnd) r = parseInt(buf.slice(ri + 4, buf.indexOf('"', ri + 4)), 10); else r = rowAuto + 1;
        if (buf.charCodeAt(tagEnd - 1) === 47) { rowAuto = r; p = tagEnd + 1; continue; }
        const re = buf.indexOf('</row>', tagEnd); if (re < 0) { p = rs; break; }
        rowAuto = r;
        const cells = []; let q = tagEnd + 1; let ci = -1;
        for (;;) {
          const cs = buf.indexOf('<c', q); if (cs < 0 || cs >= re) break;
          const ce = buf.indexOf('>', cs);
          const ai = buf.indexOf(' r="', cs);
          if (ai >= 0 && ai < ce) { let n = 0, k = ai + 4, ch; while ((ch = buf.charCodeAt(k)) >= 65 && ch <= 90) { n = n * 26 + ch - 64; k++; } ci = n - 1; } else ci++;
          if (buf.charCodeAt(ce - 1) === 47) { q = ce + 1; continue; }
          const cend = buf.indexOf('</c>', ce); q = cend + 4;
          if (ci >= maxCol) break;
          if (want && !want[ci]) continue;
          const ti = buf.indexOf(' t="', cs);
          const t = ti >= 0 && ti < ce ? buf.slice(ti + 4, buf.indexOf('"', ti + 4)) : 'n';
          let v;
          if (t === 'inlineStr') { const is = buf.indexOf('<is>', ce); v = is >= 0 && is < cend ? textOfSi(buf.slice(is + 4, buf.indexOf('</is>', is))) : ''; }
          else {
            let vs = buf.indexOf('<v', ce); if (vs < 0 || vs > cend) continue;
            vs = buf.indexOf('>', vs) + 1;
            const raw = buf.slice(vs, buf.indexOf('</v>', vs));
            if (t === 's') v = ss[+raw];
            else if (t === 'str') v = unesc(raw);
            else if (t === 'b') v = raw === '1';
            else if (t === 'e') v = null;
            else v = +raw;
          }
          cells[ci] = v;
        }
        p = re + 6;
        if (onRow(r, cells) === false) { stop = true; break; }
      }
      buf = buf.slice(p);
    }, opts.onProgress);
  }

  async function openWorkbook(file, log) {
    const zip = await openZip(file);
    const sheets = await workbookSheets(zip);
    let ss = null;
    return {
      file, zip, sheets,
      findSheet(pred) { return sheets.find(pred); },
      async strings() {
        if (!ss) { if (log) log('Lendo textos de ' + file.name + '…'); ss = await loadSharedStrings(zip); }
        return ss;
      },
      async rows(sheet, onRow, opts) {
        const s = await this.strings();
        await readSheetRows(zip, sheet.path, s, onRow, opts);
      }
    };
  }

  // ---------- Normalização ----------
  const norm = v => (v == null ? '' : String(v)).trim();
  const normU = v => norm(v).toUpperCase();
  const cod = v => (v == null ? '' : typeof v === 'number' ? String(v).padStart(6, '0') : String(v));
  const num = v => (typeof v === 'number' ? v : (v == null || v === '' ? 0 : (isFinite(+v) ? +v : 0)));
  function serialToISO(n) {
    const ms = Math.round((n - 25569) * 86400000);
    const d = new Date(ms); return d.toISOString().slice(0, 10);
  }
  function toISODate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v > 0 ? serialToISO(v) : null;
    const s = String(v).trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return null;
  }
  function headerMap(cells) {
    const h = {}; cells.forEach((v, i) => { const k = norm(v); if (k && h[k] == null) h[k] = i; }); return h;
  }
  function needCols(h, names, fileLabel) {
    const out = {}; const missing = [];
    for (const [key, alts] of Object.entries(names)) {
      const list = Array.isArray(alts) ? alts : [alts];
      const found = list.map(a => h[a]).find(x => x != null);
      if (found == null) missing.push(list[0]); else out[key] = found;
    }
    if (missing.length) throw new Error(fileLabel + ': não encontrei as colunas ' + missing.map(x => '"' + x + '"').join(', ') + ' na linha 1 da aba Base.');
    return out;
  }
  function pickSheet(wb, names, label) {
    const s = wb.sheets.find(x => names.some(n => normU(x.name) === normU(n)));
    if (!s) throw new Error(label + ': não encontrei a aba ' + names.join(' ou ') + '. Abas do arquivo: ' + wb.sheets.map(x => x.name).join(', '));
    return s;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------- Leitura das origens ----------
  async function lerEstoque(wb, cfg, log, prog) {
    const opts = { maxCol: 200, onProgress: prog };
    const sh = pickSheet(wb, ['Base'], 'Posição de Estoque');
    const exclG = new Set(cfg.estoqueGruposExcluidos.map(normU));
    const exclL = new Set(cfg.estoqueLojasExcluidas.map(normU));
    let col = null; const map = new Map(); let n = 0;
    await wb.rows(sh, (r, c) => {
      if (!col) {
        col = needCols(headerMap(c), { cod: 'CODIGO', desc: 'DESCRICAO DO PRODUTO', grupo: 'GRUPO', loja: 'Loja', fis: 'EST.FISICO', tab: 'Estoque Fisico Tabela', custo: 'CUSTO MEDIO', conc: 'Concatenar' }, 'Posição de Estoque');
        opts.maxCol = Math.max(...Object.values(col)) + 1;
        opts.want = []; Object.values(col).forEach(i => { opts.want[i] = true; });
        return;
      }
      const loja = c[col.loja];
      if (loja == null || norm(loja) === '' || exclL.has(normU(loja))) return;
      const g = c[col.grupo];
      if (exclG.has(normU(g))) return;
      if (c[col.cod] == null && c[col.fis] == null) return;
      const codigo = cod(c[col.cod]);
      const conc = c[col.conc] != null ? String(c[col.conc]) : String(loja) + codigo;
      const desc = c[col.desc] == null ? '' : String(c[col.desc]);
      const key = conc + '\u0001' + loja + '\u0001' + codigo + '\u0001' + (g == null ? '' : g) + '\u0001' + desc;
      let o = map.get(key);
      if (!o) { o = { A: conc, E: String(loja), F: codigo, G: g == null ? '' : String(g), H: desc, I: 0, J: 0, K: 0 }; map.set(key, o); }
      o.I += num(c[col.fis]); o.J += num(c[col.tab]); o.K += num(c[col.custo]); n++;
    }, opts);
    log('Posição de Estoque: ' + n.toLocaleString('pt-BR') + ' linhas lidas, ' + map.size.toLocaleString('pt-BR') + ' itens loja × produto.');
    return [...map.values()];
  }

  async function lerVendas(wb, cfg, mes, log, prog) {
    const opts = { maxCol: 200, onProgress: prog };
    const sh = pickSheet(wb, ['Base'], 'Base Margem');
    const ef = new Set(cfg.vendasEF.map(normU));
    const segS = new Set(cfg.vendasSegSemEventos.map(normU));
    const segC = new Set(cfg.vendasSegComEventos.map(normU));
    const acoesEx = cfg.vendasAcoesExcluidas.map(normU);
    const cancel = normU(cfg.vendasCancelada);
    let col = null; const sem = new Map(), com = new Map(); let n = 0, used = 0;
    const datas = new Map();
    await wb.rows(sh, (r, c) => {
      if (!col) {
        col = needCols(headerMap(c), { loja: 'Loja', prod: 'Produto', qtd: 'Quantidade', em: 'Emissao', canc: 'Cancelada', ef: 'EF', seg: ['Segmentação', 'Segmentacao'], acao: ['Ação', 'Acao'] }, 'Base Margem');
        opts.maxCol = Math.max(...Object.values(col)) + 1;
        opts.want = []; Object.values(col).forEach(i => { opts.want[i] = true; });
        return;
      }
      n++;
      const loja = c[col.loja]; if (loja == null) return;
      const d = toISODate(c[col.em]); if (d) datas.set(d.slice(0, 7), (datas.get(d.slice(0, 7)) || 0) + 1);
      if (!d || d.slice(0, 7) !== mes) return;
      if (normU(c[col.canc]) !== cancel) return;
      if (!ef.has(normU(c[col.ef]))) return;
      const acaoRaw = c[col.acao]; const acao = normU(acaoRaw);
      if (acoesEx.some(a => a && acao === a)) return;
      const seg = normU(c[col.seg]);
      const key = String(loja) + cod(c[col.prod]);
      const q = num(c[col.qtd]);
      if (segS.has(seg)) { sem.set(key, (sem.get(key) || 0) + q); used++; }
      const acaoVazia = acaoRaw == null || acaoRaw === '';
      if (segC.has(seg) && !(cfg.vendasComEventosExcluiAcaoVazia && acaoVazia)) com.set(key, (com.get(key) || 0) + q);
    }, opts);
    log('Base Margem: ' + n.toLocaleString('pt-BR') + ' linhas, ' + used.toLocaleString('pt-BR') + ' usadas em ' + mes + '.');
    if (!sem.size) {
      const meses = [...datas.entries()].sort().map(([m, k]) => m + ' (' + k.toLocaleString('pt-BR') + ')').join(', ');
      throw new Error('Base Margem: nenhuma venda encontrada no mês ' + mes + '. Meses presentes no arquivo: ' + (meses || 'nenhum') + '.');
    }
    const fator = 1 + (cfg.margemSeguranca || 0);
    for (const m of [sem, com]) for (const [k, v] of m) m.set(k, v * fator);
    return { sem, com };
  }

  async function lerCompras(wb, cfg, de, ate, log, prog) {
    const opts = { maxCol: 200, onProgress: prog };
    const sh = pickSheet(wb, ['Base'], 'Compras FWI');
    const forn = new Set(cfg.comprasFornecedores.map(normU));
    const cfop = new Set(cfg.comprasCFOP.map(normU));
    const opEx = new Set(cfg.comprasOperacoesExcluidas.map(norm));
    const opBoni = new Set(cfg.comprasOperacoesBoni.map(norm));
    let col = null; const compra = new Map(), boni = new Map(); let n = 0, nc = 0, nb = 0;
    const add = (m, k, row, q, v) => { let o = m.get(k); if (!o) { o = Object.assign({ q: 0, v: 0 }, row); m.set(k, o); } o.q += q; o.v += v; };
    await wb.rows(sh, (r, c) => {
      if (!col) {
        col = needCols(headerMap(c), { loja: 'Loja', prod: 'PRODUTO', desc: 'DESCRICAO', op: 'OPERACAO', nome: 'NOME', cfop: ['Descrição CFOP', 'Descricao CFOP'], q: 'QUANTIDADE', v: 'VALOR TOTAL', em: 'EMISSAO' }, 'Compras FWI');
        opts.maxCol = Math.max(...Object.values(col)) + 1;
        opts.want = []; Object.values(col).forEach(i => { opts.want[i] = true; });
        return;
      }
      n++;
      const d = toISODate(c[col.em]); if (!d || d < de || d > ate) return;
      if (!forn.has(normU(c[col.nome]))) return;
      const loja = c[col.loja]; if (loja == null) return;
      const prod = cod(c[col.prod]);
      const op = norm(typeof c[col.op] === 'number' ? c[col.op].toFixed(3) : c[col.op]);
      const row = { loja: String(loja), prod, desc: c[col.desc] == null ? '' : String(c[col.desc]), op };
      const k = row.loja + '\u0001' + prod + '\u0001' + row.desc + '\u0001' + op;
      if (opBoni.has(op)) { add(boni, k, row, num(c[col.q]), num(c[col.v])); nb++; }
      else if (!opEx.has(op) && cfop.has(normU(c[col.cfop]))) { add(compra, k, row, num(c[col.q]), num(c[col.v])); nc++; }
    }, opts);
    log('Compras FWI: ' + n.toLocaleString('pt-BR') + ' linhas, ' + nc + ' de compra e ' + nb + ' de boni entre ' + de + ' e ' + ate + '.');
    const sortRows = m => [...m.values()].sort((a, b) => a.loja.localeCompare(b.loja) || a.prod.localeCompare(b.prod) || a.op.localeCompare(b.op));
    return { compra: sortRows(compra), boni: sortRows(boni) };
  }

  // Lê aba "De-para" (A:AC), "Top 20" (I:M) ou uma aba Criticos (A:K) de qualquer pasta de trabalho
  async function lerReferencia(file, tipo, log) {
    const wb = await openWorkbook(file, log);
    if (tipo === 'depara') {
      const sh = pickSheet(wb, ['De-para'], file.name);
      const rows = [];
      await wb.rows(sh, (r, c) => { rows[r - 1] = c.slice(0, 29); }, { maxCol: 29 });
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      return rows;
    }
    if (tipo === 'top20') {
      const sh = pickSheet(wb, ['Top 20'], file.name);
      const rows = []; let mes = null;
      await wb.rows(sh, (r, c) => {
        if (r === 1 && c[8] != null) mes = String(c[8]);
        if (r >= 4 && c[8] != null && c[9] != null) rows.push([String(c[8]), String(c[9]), c[10] == null ? '' : String(c[10]), c[11] == null ? null : c[11], c[12] == null ? '' : String(c[12])]);
      }, { maxCol: 13 });
      return { mes, rows };
    }
    if (tipo === 'critico') {
      const crit = wb.sheets.filter(s => /^criticos?_estoque/i.test(s.name));
      if (!crit.length) throw new Error(file.name + ': nenhuma aba "Criticos_estoque…" encontrada.');
      const sh = crit[crit.length - 1];
      return lerCriticoSheet(wb, sh);
    }
  }
  async function lerCriticoSheet(wb, sh) {
    const rows = []; let hdr = null;
    await wb.rows(sh, (r, c) => {
      if (!hdr) { if (normU(c[0]) === 'CONCATENAR') hdr = r; return; }
      if (c[0] == null) return;
      rows.push([String(c[0]), c[4] == null ? '' : String(c[4]), c[5] == null ? '' : String(c[5]), c[6] == null ? '' : String(c[6]), c[7] == null ? '' : String(c[7]), num(c[8]), num(c[9]), num(c[10])]);
    }, { maxCol: 11 });
    return { nome: sh.name, rows };
  }

  // ---------- Cálculo ----------
  function calcular(est, vendas, compras, refs, p) {
    const dp = refs.depara;
    const reg = new Map(), pack = new Map(), exe = new Map();
    for (let i = 2; i < dp.length; i++) {
      const r = dp[i] || [];
      if (r[4] != null && !reg.has(String(r[4]))) reg.set(String(r[4]), [r[5], r[6]]);
      if (r[16] != null && !pack.has(String(r[16]))) pack.set(String(r[16]), r[15]);
      if (r[21] != null) { const k = String(r[21]) + '\u0001' + (r[23] == null ? '' : String(r[23])); exe.set(k, (exe.get(k) || 0) + num(r[28])); }
    }
    const top = new Map(); for (const r of refs.top20.rows) { const k = r[0] + r[1]; if (!top.has(k)) top.set(k, r[4]); }
    const ant = new Map(); if (refs.anterior) for (const r of refs.anterior.rows) if (!ant.has(r[0])) ant.set(r[0], r);
    const cg = new Map(), cb = new Map();
    for (const r of compras.compra) { const k = r.loja + '\u0001' + r.prod; cg.set(k, (cg.get(k) || 0) + r.v); }
    for (const r of compras.boni) { const k = r.loja + '\u0001' + r.prod; cb.set(k, (cb.get(k) || 0) + r.v); }
    const W2 = p.diasAlvo;
    const packDiv = (x, f) => { const pk = pack.get(f); if (pk == null || typeof pk !== 'number' || pk === 0) return 0; return x / pk; };
    const out = est.map(e => {
      const k2 = e.E + '\u0001' + e.F;
      const rg = reg.get(e.E);
      const L = vendas.sem.get(e.E + e.F) || 0;
      const N = vendas.com.get(e.E + e.F) || 0;
      const M = L === 0 ? 'Venda Zerada' : e.I / L * 30;
      const O = N === 0 ? 9999 : e.I / N * 30;
      const R = O === 0 ? 0 : e.I * W2 / O;
      const T = e.I - R;
      const V = e.I === 0 ? 0 : T * (e.J / e.I);
      const AD = exe.get(k2) || 0;
      const a = ant.get(e.A);
      return Object.assign({}, e, {
        B: rg ? (rg[1] == null ? 0 : rg[1]) : 'Sem regional', C: rg ? (rg[0] == null ? 0 : rg[0]) : 'Sem regional', D: top.has(e.A) ? top.get(e.A) : 'Nok',
        L, M, N, O, P: cg.get(k2) || 0, Q: cb.get(k2) || 0,
        R, S: packDiv(R, e.F), T, U: packDiv(T, e.F), V,
        AD, AE: packDiv(AD, e.F), AF: N === 0 ? 0 : AD / N * 30,
        AG: a ? a[5] : 0, AH: a ? a[6] : 0
      });
    });
    out.forEach(r => { r.AI = r.AH - r.J; });
    out.sort((x, y) => y.J - x.J);
    return out;
  }

  async function executar(inp, refs, cfg, p, log, prog) {
    log('Abrindo Posição de Estoque…');
    const wbE = await openWorkbook(inp.estoque, log);
    const est = await lerEstoque(wbE, cfg, log, f => prog && prog('estoque', f)); await tick();
    log('Abrindo Base Margem (' + p.mesVendas + ')…');
    const wbV = await openWorkbook(inp.vendas, log);
    const vendas = await lerVendas(wbV, cfg, p.mesVendas, log, f => prog && prog('vendas', f)); await tick();
    log('Abrindo Compras FWI…');
    const wbC = await openWorkbook(inp.compras, log);
    const compras = await lerCompras(wbC, cfg, p.comprasDe, p.comprasAte, log, f => prog && prog('compras', f)); await tick();
    log('Calculando o crítico…');
    const linhas = calcular(est, vendas, compras, refs, p);
    log('Pronto: ' + linhas.length.toLocaleString('pt-BR') + ' linhas.');
    return { linhas, compras };
  }

  // ---------- Escrita do XLSX ----------
  const xesc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const RS = '_-"R$"\\ * #,##0_-;\\-"R$"\\ * #,##0_-;_-"R$"\\ * "-"??_-;_-@_-';
  const RS2 = '_-"R$"\\ * #,##0.00_-;\\-"R$"\\ * #,##0.00_-;_-"R$"\\ * "-"??_-;_-@_-';
  // estilos: [numFmt, fill, bold, fontWhite, align]
  const FILLS = { azul: 'FF2F5597', cinza: 'FF333F50', cinzaEsc: 'FF222A35', verde: 'FF548235', amarelo: 'FFFFD966', laranja: 'FFF4B183', azulC: 'FF2E75B6', amareloV: 'FFFFFF00', claro: 'FFF2F2F2' };
  const STY = {};
  const styleList = [];
  function defStyle(name, fmt, fill, bold, white, align) { STY[name] = styleList.length; styleList.push({ fmt, fill, bold, white, align }); }
  defStyle('def', 0, null, false, false, 'center');
  ['azul', 'cinza', 'cinzaEsc', 'verde', 'amarelo', 'laranja', 'azulC'].forEach(f => {
    const white = !['amarelo', 'laranja'].includes(f);
    defStyle('h_' + f, 0, f, true, white, 'centerWrap');
  });
  defStyle('tot_int', 3, null, true, false, 'center'); defStyle('tot_rs', RS, null, true, false, 'center'); defStyle('tot_rs2', RS2, null, true, false, 'center');
  defStyle('tot_0', 1, null, true, false, 'center'); defStyle('tot_num', '#,##0_ ;\\-#,##0\\ ', null, true, false, 'center');
  defStyle('int', 3, null, false, false, 'center'); defStyle('rs', RS, null, false, false, 'center'); defStyle('rs2', RS2, null, false, false, 'center');
  defStyle('txt', 0, null, false, false, 'center'); defStyle('txtL', 0, null, false, false, 'left'); defStyle('conc', 0, 'claro', false, false, 'center');
  defStyle('amar_int', 3, 'amareloV', false, false, 'center'); defStyle('amar_dec', 2, 'amareloV', true, false, 'center');
  defStyle('dec1', 1, null, false, false, 'center'); defStyle('dec2', 2, null, false, false, 'center'); defStyle('data', 14, null, false, false, 'center');
  defStyle('bold', 0, null, true, false, 'left');

  function stylesXml() {
    const fmts = []; const fmtId = {}; let next = 164;
    const fid = f => { if (typeof f === 'number') return f; if (fmtId[f] == null) { fmtId[f] = next++; fmts.push(f); } return fmtId[f]; };
    const fillKeys = Object.keys(FILLS);
    const xfs = styleList.map(s => {
      const nf = fid(s.fmt); const fill = s.fill ? 2 + fillKeys.indexOf(s.fill) : 0;
      const font = s.bold ? (s.white ? 2 : 1) : 0;
      const al = s.align === 'centerWrap' ? '<alignment horizontal="center" vertical="center" wrapText="1"/>' : s.align === 'left' ? '<alignment horizontal="left" vertical="center"/>' : '<alignment horizontal="center" vertical="center"/>';
      return `<xf numFmtId="${nf}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1">${al}</xf>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<numFmts count="${fmts.length}">` + fmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xesc(f)}"/>`).join('') + '</numFmts>' +
      '<fonts count="3"><font><sz val="11"/><name val="Aptos Narrow"/><family val="2"/></font><font><b/><sz val="11"/><name val="Aptos Narrow"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos Narrow"/><family val="2"/></font></fonts>' +
      `<fills count="${2 + fillKeys.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` + fillKeys.map(k => `<fill><patternFill patternType="solid"><fgColor rgb="${FILLS[k]}"/><bgColor indexed="64"/></patternFill></fill>`).join('') + '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">` + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }

  function makeSST() {
    const map = new Map(); const list = [];
    return { idx(s) { let i = map.get(s); if (i == null) { i = list.length; list.push(s); map.set(s, i); } return i; }, list };
  }

  // célula: {v, f, s} ; v string|number|null
  function cellXml(ref, c, sst) {
    if (c == null) return '';
    if (typeof c !== 'object') c = { v: c };
    const s = c.s != null ? ` s="${STY[c.s]}"` : '';
    const f = c.f ? `<f>${xesc(c.f)}</f>` : '';
    const v = c.v;
    if (v == null || v === '') {
      if (c.f) return `<c r="${ref}"${s} t="str">${f}<v></v></c>`;
      return s ? `<c r="${ref}"${s}/>` : '';
    }
    if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${s}>${f}<v>${v}</v></c>` : `<c r="${ref}"${s} t="e">${f}<v>#DIV/0!</v></c>`;
    if (typeof v === 'string' && v.startsWith('#N/D')) return `<c r="${ref}"${s} t="e">${f}<v>#N/A</v></c>`;
    if (c.f) return `<c r="${ref}"${s} t="str">${f}<v>${xesc(v)}</v></c>`;
    return `<c r="${ref}"${s} t="s"><v>${sst.idx(String(v))}</v></c>`;
  }
  function sheetXml(rows, sst, opt) {
    opt = opt || {};
    const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'];
    if (opt.tab) parts.push(`<sheetPr><tabColor rgb="${opt.tab}"/><outlinePr summaryRight="0"/></sheetPr>`);
    parts.push('<sheetViews><sheetView workbookViewId="0"' + (opt.selected ? ' tabSelected="1"' : '') + (opt.noGrid ? ' showGridLines="0"' : '') + (opt.zoom ? ` zoomScale="${opt.zoom}"` : '') + '>');
    if (opt.freeze) parts.push(`<pane xSplit="${opt.freeze[0]}" ySplit="${opt.freeze[1]}" topLeftCell="${colName(opt.freeze[0])}${opt.freeze[1] + 1}" activePane="bottomRight" state="frozen"/>`);
    parts.push('</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"' + (opt.outlineCols ? ` outlineLevelCol="${opt.outlineCols}"` : '') + '/>');
    if (opt.cols) parts.push('<cols>' + opt.cols.map((c, i) => c ? `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"${c.h ? ' hidden="1"' : ''}${c.o ? ` outlineLevel="${c.o}"` : ''}/>` : '').join('') + '</cols>');
    parts.push('<sheetData>');
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]; if (!row) continue;
      let x = `<row r="${r + 1}"${opt.rowHeights && opt.rowHeights[r] ? ` ht="${opt.rowHeights[r]}" customHeight="1"` : ''}>`;
      for (let c = 0; c < row.length; c++) if (row[c] != null) x += cellXml(colName(c) + (r + 1), row[c], sst);
      parts.push(x + '</row>');
    }
    parts.push('</sheetData>');
    if (opt.autoFilter) parts.push(opt.sortDesc ? `<autoFilter ref="${opt.autoFilter}"><sortState ref="${opt.sortDesc[0]}"><sortCondition descending="1" ref="${opt.sortDesc[1]}"/></sortState></autoFilter>` : `<autoFilter ref="${opt.autoFilter}"/>`);
    if (opt.validations && opt.validations.length) {
      parts.push('<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"><x14:dataValidations count="' + opt.validations.length + '">' +
        opt.validations.map(v => `<x14:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"><x14:formula1><xm:f>${xesc(v.f)}</xm:f></x14:formula1><xm:sqref>${v.ref}</xm:sqref></x14:dataValidation>`).join('') +
        '</x14:dataValidations></ext></extLst>');
    }
    parts.push('</worksheet>');
    return parts.join('');
  }
  const q = n => "'" + n.replace(/'/g, "''") + "'";

  function gerarXlsx(res, refs, p) {
    const sst = makeSST();
    const nome = p.nomeAba; // "Criticos_estoque_em 21_10"
    const antNome = refs.anterior ? (refs.anterior.nome === nome ? (refs.anterior.nome.slice(0, 25) + ' (ant)') : refs.anterior.nome) : null;
    const L = res.linhas; const last = L.length + 3;
    const rows = [];
    const H = (t, fill) => ({ v: t, s: 'h_' + fill });
    rows[0] = []; rows[0][17] = H('RACIONAL DE REDUÇÃO', 'cinzaEsc'); rows[0][22] = H('AÇÕES', 'verde'); rows[0][25] = H('trazer giro da execução', 'verde'); rows[0][32] = H('ESTOQUE ANTERIOR', 'azulC');
    const r2 = rows[1] = [];
    const sumIn = arr => arr.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    const tot = k => sumIn(L.map(r => r[k]));
    const tI = tot('I'), tJ = tot('J'), tL = tot('L'), tN = tot('N');
    const tO = tN ? tI / tN * 30 : 9999, tR = tO ? tI * p.diasAlvo / tO : 0;
    r2[0] = { v: 'Arrastar a fórmula', s: 'conc' };
    r2[8] = { v: tI, f: `SUBTOTAL(9,I4:I${last})`, s: 'tot_int' };
    r2[9] = { v: tJ, f: `SUBTOTAL(9,J4:J${last})`, s: 'tot_rs' };
    r2[11] = { v: tL, f: `SUBTOTAL(9,L4:L${last})`, s: 'tot_num' };
    r2[12] = { v: tL ? tI / tL * 30 : 0, f: 'IFERROR(I2/L2*30,0)', s: 'tot_0' };
    r2[13] = { v: tN, f: `SUBTOTAL(9,N4:N${last})`, s: 'amar_int' };
    r2[14] = { v: tO, f: 'IFERROR((I2/N2)*30,9999)', s: 'amar_dec' };
    r2[15] = { v: tot('P'), f: `SUBTOTAL(9,P4:P${last})`, s: 'tot_rs' };
    r2[16] = { v: tot('Q'), f: `SUBTOTAL(9,Q4:Q${last})`, s: 'tot_rs' };
    r2[17] = { v: tR, f: 'IFERROR((I2*$W$2)/O2,0)', s: 'int' };
    r2[19] = { v: tI - tR, f: 'I2-R2', s: 'int' };
    r2[21] = { v: tI ? (tI - tR) * tJ / tI : 0, f: 'IFERROR(T2*(J2/I2),0)', s: 'rs2' };
    r2[22] = { v: p.diasAlvo, s: 'bold' };
    r2[26] = { v: 'CALCULO P/ PROJEÇÕES ESTOQUE:', s: 'bold' };
    r2[28] = { v: '', f: 'IF(AB2="","",((AB2+I2)/L2)*30)', s: 'dec2' };
    const tAH = tot('AH');
    r2[33] = { v: tAH, f: `SUBTOTAL(9,AH4:AH${last})`, s: 'tot_rs' };
    r2[34] = { v: tAH - tJ, f: 'AH2-J2', s: 'tot_rs' };
    const hdr = [['CONCATENAR', 'azul'], ['REGIONAL', 'azul'], ['Nº REG.', 'azul'], ['Top 20?', 'azul'], ['Loja', 'azul'], ['CODIGO', 'azul'], ['GRUPO', 'azul'], ['DESCRICAO DO PRODUTO', 'azul'], ['Físico ', 'azul'], ['R$ Tabela', 'azul'], ['Custo médio R$', 'azul'], ['Vendas S/ eventos (und)', 'azul'], ['Dias Estoque', 'azul'], ['Vendas C/ eventos (Und)', 'azul'], ['Dias Estoque', 'azul'], ['Compras período', 'cinza'], ['Boni', 'cinza'], ['Estoque máximo (Unid)', 'cinzaEsc'], ['Estoque máximo (Pack)', 'cinzaEsc'], ['Venda necessária (Unid)', 'cinzaEsc'], ['Venda necessária (Pack)', 'cinzaEsc'], ['Venda em R$', 'cinzaEsc'], ['Ação', 'verde'], ['Observação', 'verde'], ['Dono ação', 'verde'], ['Data da ação', 'verde'], ['Loja', 'amarelo'], ['Qtde (unidades)', 'amarelo'], ['Dias de estoque projetado', 'amarelo'], ['Execução em loja (Unid)', 'laranja'], ['Execução em loja (Pack)', 'laranja'], ['Dias de estoque execução', 'laranja'], ['Estoque anterior (Und)', 'azulC'], ['Estoque anterior R$', 'azulC'], ['DIF', 'azulC']];
    rows[2] = hdr.map(([t, f]) => H(t, f));
    const ant = antNome ? q(antNome) : null;
    const DP = q('De-para'), TP = q('Top 20');
    const AN = refs.anotacoes || new Map();
    const isoSerial = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569 : null; };
    const anotCells = r => {
      const a = AN.get(r.E + '\u0001' + r.F); if (!a) return [null, null, null, null];
      const sd = isoSerial(a.data);
      return [a.acao ? { v: a.acao, s: 'txtL' } : null, a.obs ? { v: a.obs, s: 'txtL' } : null, a.dono ? { v: a.dono, s: 'txt' } : null, sd ? { v: sd, s: 'data' } : (a.data ? { v: a.data, s: 'txt' } : null)];
    };
    for (let i = 0; i < L.length; i++) {
      const r = L[i]; const n = i + 4;
      rows[n - 1] = [
        { v: r.A, f: `E${n}&F${n}`, s: 'conc' },
        { v: r.B, f: `IFERROR(VLOOKUP(E${n},${DP}!$E:$G,3,0),"Sem regional")`, s: 'txt' },
        { v: r.C, f: `IFERROR(VLOOKUP(E${n},${DP}!$E:$F,2,0),"Sem regional")`, s: 'txt' },
        { v: r.D, f: `IFERROR(_xlfn.XLOOKUP(A${n},${TP}!$H:$H,${TP}!$M:$M),"Nok")`, s: 'txt' },
        { v: r.E, s: 'txtL' }, { v: r.F, s: 'txt' }, { v: r.G, s: 'txtL' }, { v: r.H, s: 'txtL' },
        { v: r.I, s: 'int' }, { v: r.J, s: 'rs' }, { v: r.K, s: 'rs2' },
        { v: r.L, s: 'int' },
        { v: r.M, f: `IF(L${n}=0,"Venda Zerada",I${n}/L${n}*30)`, s: 'dec1' },
        { v: r.N, s: 'amar_int' },
        { v: r.O, f: `IFERROR((I${n}/N${n})*30,9999)`, s: 'amar_dec' },
        { v: r.P, f: `SUMIFS(Compras!$G:$G,Compras!$B:$B,E${n},Compras!$C:$C,F${n})`, s: 'rs' },
        { v: r.Q, f: `SUMIFS(Compras!$N:$N,Compras!$I:$I,E${n},Compras!$J:$J,F${n})`, s: 'rs' },
        { v: r.R, f: `IFERROR((I${n}*$W$2)/O${n},0)`, s: 'int' },
        { v: r.S, f: `IFERROR(R${n}/(_xlfn.XLOOKUP(F${n},${DP}!$Q:$Q,${DP}!$P:$P)),0)`, s: 'int' },
        { v: r.T, f: `I${n}-R${n}`, s: 'int' },
        { v: r.U, f: `IFERROR(T${n}/(_xlfn.XLOOKUP(F${n},${DP}!$Q:$Q,${DP}!$P:$P)),0)`, s: 'int' },
        { v: r.V, f: `IFERROR(T${n}*(J${n}/I${n}),0)`, s: 'rs2' },
        ...anotCells(r),
        null, null,
        { v: '', f: `IF(AB${n}="","",((AB${n}+I${n})/L${n})*30)`, s: 'dec1' },
        { v: r.AD, f: `SUMIFS(${DP}!$AC:$AC,${DP}!$V:$V,E${n},${DP}!$X:$X,F${n})`, s: 'int' },
        { v: r.AE, f: `IFERROR(AD${n}/(_xlfn.XLOOKUP(F${n},${DP}!$Q:$Q,${DP}!$P:$P)),0)`, s: 'int' },
        { v: r.AF, f: `IFERROR((AD${n}/N${n})*30,0)`, s: 'dec1' },
        ant ? { v: r.AG, f: `IFERROR(_xlfn.XLOOKUP(A${n},${ant}!A:A,${ant}!I:I),0)`, s: 'int' } : { v: r.AG || 0, s: 'int' },
        ant ? { v: r.AH, f: `IFERROR(_xlfn.XLOOKUP(A${n},${ant}!A:A,${ant}!J:J),0)`, s: 'rs' } : { v: r.AH || 0, s: 'rs' },
        { v: r.AI, f: `AH${n}-J${n}`, s: 'rs2' }
      ];
    }
    const W = [34.4, 19.1, 8.4, 11.4, 13.7, 11, 18.3, 36.7, 13.4, 17.3, 12.1, 12.7, 12.7, 14.6, 11.6, 13, 13.4, 13.1, 13.1, 13.9, 14.3, 20.1, 18.1, 13.3, 9.7, 16.1, 18.3, 17.4, 30.1, 30.1, 15.7, 16.7, 9.9, 16.6, 14.7];
    const HID = { 0: 2, 1: 1, 2: 1, 6: 1, 11: 1, 12: 1, 17: 2, 18: 1, 19: 2, 20: 1, 21: 1, 26: 2, 27: 2, 28: 2, 29: 3, 30: 1, 31: 1 };
    const cols = W.map((w, i) => ({ w, h: HID[i] != null && p.ocultarColunas, o: HID[i] }));
    const dv = [];
    if (refs.depara.length > 3) { dv.push({ f: `${DP}!$J$3:$J$12`, ref: `W4:W${last}` }); dv.push({ f: `${DP}!$L$3:$L$6`, ref: `Y4:Y${last}` }); }
    const sheets = [];
    sheets.push({ name: nome, xml: sheetXml(rows, sst, { tab: 'FF000000', selected: true, noGrid: true, zoom: 80, freeze: [8, 3], cols, outlineCols: 3, autoFilter: `A3:AI${last}`, sortDesc: [`A4:AI${last}`, `J4:J${last}`], validations: dv, rowHeights: { 2: 48 } }) });

    // aba do crítico anterior (para as fórmulas de estoque anterior)
    if (antNome) {
      const ar = [[], [], ['CONCATENAR', null, null, null, 'Loja', 'CODIGO', 'GRUPO', 'DESCRICAO DO PRODUTO', 'Físico ', 'R$ Tabela', 'Custo médio R$'].map(t => t == null ? null : H(t, 'azul'))];
      ar[0][0] = { v: 'Base do crítico anterior (' + antNome + ') usada nas colunas Estoque anterior.', s: 'bold' };
      refs.anterior.rows.forEach(r => ar.push([{ v: r[0], s: 'conc' }, null, null, null, { v: r[1], s: 'txtL' }, { v: r[2], s: 'txt' }, { v: r[3], s: 'txtL' }, { v: r[4], s: 'txtL' }, { v: r[5], s: 'int' }, { v: r[6], s: 'rs' }, { v: r[7], s: 'rs2' }]));
      sheets.push({ name: antNome, xml: sheetXml(ar, sst, { freeze: [0, 3], cols: [{ w: 30 }, { w: 3 }, { w: 3 }, { w: 3 }, { w: 18 }, { w: 10 }, { w: 22 }, { w: 40 }, { w: 12 }, { w: 14 }, { w: 12 }], autoFilter: `A3:K${ar.length}` }) });
    }
    // Compras
    const cr = [];
    cr[0] = []; cr[0][1] = { v: 'COMPRA', s: 'bold' }; cr[0][8] = { v: 'BONI', s: 'bold' };
    cr[1] = []; cr[1][1] = { v: 'EMISSAO', s: 'bold' }; cr[1][2] = { v: p.comprasDe.split('-').reverse().join('/') + ' a ' + p.comprasAte.split('-').reverse().join('/'), s: 'txtL' };
    cr[2] = []; cr[2][1] = { v: 'Fornecedores', s: 'bold' }; cr[2][2] = { v: p.fornecedoresResumo, s: 'txtL' };
    cr[6] = []; ['Loja', 'PRODUTO', 'DESCRICAO', 'OPERACAO', 'Soma de QUANTIDADE', 'Soma de VALOR TOTAL'].forEach((t, i) => { cr[6][1 + i] = H(t, 'azul'); cr[6][8 + i] = H(t, 'azul'); });
    const nC = Math.max(res.compras.compra.length, res.compras.boni.length);
    for (let i = 0; i < nC; i++) {
      const row = []; const a = res.compras.compra[i], b = res.compras.boni[i];
      if (a) { row[1] = { v: a.loja, s: 'txtL' }; row[2] = { v: a.prod, s: 'txt' }; row[3] = { v: a.desc, s: 'txtL' }; row[4] = { v: a.op, s: 'txt' }; row[5] = { v: a.q, s: 'int' }; row[6] = { v: a.v, s: 'rs2' }; }
      if (b) { row[8] = { v: b.loja, s: 'txtL' }; row[9] = { v: b.prod, s: 'txt' }; row[10] = { v: b.desc, s: 'txtL' }; row[11] = { v: b.op, s: 'txt' }; row[12] = { v: b.q, s: 'int' }; row[13] = { v: b.v, s: 'rs2' }; }
      cr[7 + i] = row;
    }
    sheets.push({ name: 'Compras', xml: sheetXml(cr, sst, { freeze: [0, 7], cols: [{ w: 3 }, { w: 20 }, { w: 10 }, { w: 40 }, { w: 10 }, { w: 12 }, { w: 15 }, { w: 3 }, { w: 20 }, { w: 10 }, { w: 40 }, { w: 10 }, { w: 12 }, { w: 15 }] }) });
    // De-para
    const dr = refs.depara.map(r => (r || []).map(v => v == null ? null : { v, s: typeof v === 'number' ? null : null }));
    sheets.push({ name: 'De-para', xml: sheetXml(dr, sst, {}) });
    // Top 20
    const tr = [[], [], []];
    tr[0][8] = { v: refs.top20.mes || '', s: 'bold' };
    ['Loja', 'Produto', 'Descricao do Produto', 'Ranking'].forEach((t, i) => { tr[2][8 + i] = H(t, 'azul'); });
    tr[2][7] = H('Chave', 'azul'); tr[2][12] = H('Top 20?', 'azul');
    refs.top20.rows.forEach((r, i) => { const n = i + 4; tr.push([null, null, null, null, null, null, null, { v: r[0] + r[1], f: `I${n}&J${n}` }, r[0], r[1], r[2], r[3], r[4]]); });
    sheets.push({ name: 'Top 20', xml: sheetXml(tr, sst, { cols: [null, null, null, null, null, null, null, { w: 30 }, { w: 20 }, { w: 10 }, { w: 40 }, { w: 9 }, { w: 9 }] }) });

    return pacote(sheets, sst, `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xesc(q(nome))}!$A$3:$AI$${last}</definedName></definedNames>`);
  }

  // Exporta uma tabela simples (a visão da tela): titulo na linha 1, cabeçalho na linha 3, dados a partir da 4.
  function gerarXlsxTabela(nomeAba, titulo, cols, linhas) {
    const sst = makeSST();
    const rows = [[{ v: titulo, s: 'bold' }], [], cols.map(c => ({ v: c.t, s: 'h_azul' }))];
    for (const l of linhas) rows.push(l.map((v, i) => v == null || v === '' ? null : { v, s: typeof v === 'number' ? cols[i].s : (cols[i].s === 'txtL' ? 'txtL' : 'txt') }));
    const last = rows.length; const lc = colName(cols.length - 1);
    const nome = nomeAba.slice(0, 31);
    const xml = sheetXml(rows, sst, { selected: true, freeze: [0, 3], cols: cols.map(c => ({ w: c.w || 14 })), autoFilter: `A3:${lc}${last}`, rowHeights: { 2: 32 } });
    return pacote([{ name: nome, xml }], sst, `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xesc(q(nome))}!$A$3:$${lc}$${last}</definedName></definedNames>`);
  }

  // Várias abas de tabela num xlsx só. Cada aba vai para o zip assim que fica pronta, para não segurar tudo na memória.
  async function gerarXlsxAbas(abas, onProgress) {
    const sst = makeSST();
    const out = [];
    let fim, erro;
    const pronto = new Promise((res, rej) => { fim = res; erro = rej; });
    const zip = new fflate.Zip((err, chunk, final) => { if (err) return erro(err); out.push(chunk); if (final) fim(); });
    const enc = t => fflate.strToU8(t);
    const add = (nome, txt) => { const f = new fflate.ZipDeflate(nome, { level: 6 }); zip.add(f); f.push(enc(txt), true); };
    const nomes = [], filtros = [];
    for (let i = 0; i < abas.length; i++) {
      const a = typeof abas[i] === 'function' ? await abas[i]() : abas[i];
      const rows = [[{ v: a.titulo, s: 'bold' }], [], a.cols.map(c => ({ v: c.t, s: 'h_azul' }))];
      for (const l of a.linhas) rows.push(l.map((v, j) => v == null || v === '' ? null : { v, s: typeof v === 'number' ? a.cols[j].s : (a.cols[j].s === 'txtL' ? 'txtL' : 'txt') }));
      const last = rows.length, lc = colName(a.cols.length - 1);
      const nome = a.nome.slice(0, 31); nomes.push(nome);
      if (a.linhas.length) filtros.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xesc(q(nome))}!$A$3:$${lc}$${last}</definedName>`);
      add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows, sst, { selected: i === 0, tab: a.tab, freeze: [0, 3], cols: a.cols.map(c => ({ w: c.w || 14 })), autoFilter: a.linhas.length ? `A3:${lc}${last}` : null, rowHeights: { 2: 32 } }));
      if (onProgress) onProgress((i + 1) / abas.length);
      await new Promise(r => setTimeout(r, 0));
    }
    const n = nomes.length;
    add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + nomes.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>');
    add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' + nomes.map((s, i) => `<sheet name="${xesc(s)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' + (filtros.length ? '<definedNames>' + filtros.join('') + '</definedNames>' : '') + '<calcPr calcId="191029"/></workbook>');
    add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + nomes.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
    add('xl/styles.xml', stylesXml());
    add('xl/sharedStrings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + sst.list.length + '" uniqueCount="' + sst.list.length + '">' + sst.list.map(t => '<si><t xml:space="preserve">' + xesc(t) + '</t></si>').join('') + '</sst>');
    zip.end();
    await pronto;
    return new Blob(out, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function pacote(sheets, sst, definedNames) {
    const files = {};
    const enc = s => fflate.strToU8(s);
    files['[Content_Types].xml'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>');
    files['_rels/.rels'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    files['xl/workbook.xml'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' + sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' + (definedNames || '') + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
    files['xl/_rels/workbook.xml.rels'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
    sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = enc(s.xml); });
    files['xl/styles.xml'] = enc(stylesXml());
    files['xl/sharedStrings.xml'] = enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + sst.list.length + '" uniqueCount="' + sst.list.length + '">' + sst.list.map(t => '<si><t xml:space="preserve">' + xesc(t) + '</t></si>').join('') + '</sst>');
    return fflate.zipSync(files, { level: 6 });
  }

  const DEFAULT_CFG = {
    estoqueGruposExcluidos: ['ATIVO DE TERCEIROS', 'ATIVO IMOBILIZADO', 'ATIVOS DE GIRO', 'DISTRIBUICAO A FUNCIONARIOS', 'SORVETES', 'USO E CONSUMO'],
    estoqueLojasExcluidas: ['Araraquara 1 Mini', 'Piracicaba 2 Mini', 'São Carlos Franquia', 'São Carlos 2 Franquia', 'Rio Preto Franquia', 'Pemar Franquia', 'Belo Horizonte Franquia', 'The Wow Factory'],
    vendasCancelada: 'F',
    vendasEF: ['Cupom Fiscal', 'Nota Fiscal'],
    vendasSegSemEventos: ['Delivery', 'Lojas', 'Pitstop'],
    vendasSegComEventos: ['Delivery', 'Eventos', 'Lojas', 'Pitstop'],
    vendasAcoesExcluidas: ['3-Queima de Estoque'],
    vendasComEventosExcluiAcaoVazia: true,
    margemSeguranca: 0,
    comprasFornecedores: ['AMBEV S.A.', 'AMBEV S.A. - CDD ARARAQUARA', 'AMBEV S.A. - F. CONTAGEM', 'AMBEV S/A - CDI LOUVEIRA', 'AMBEV S/A - F. JACAREI', 'AMBEV S/A CDI - GUARULHOS', 'BEVALE COMERCIO DE BEBIDAS LTDA', 'BIERHAUSEN COMERCIAL - EIRELI', 'CONEBEL COMERCIAL NEVES DE BEBIDAS LTDA', 'CRBS S/A', 'CRBS SA - CDD BELO HORIZONTE', 'CRBS SA - CDD UBERABA', 'CRBS SA - CDD UBERLANDIA', 'CRBS SA - CDL SANTA LUZIA', 'MENEGAZZO & CIA LTDA'],
    comprasCFOP: ['Compras para Comercialização com ST dentro do estado', 'Compras para Comercialização com ST fora do estado', 'Compras para Comercialização dentro do estado', 'Compras para Comercialização fora do estado'],
    comprasOperacoesExcluidas: ['1.910', '2.910', '1.949'],
    comprasOperacoesBoni: ['1.910', '2.910']
  };

  root.CriticoEngine = { gerarXlsxTabela, gerarXlsxAbas, _stream: streamEntry, _lerVendas: lerVendas, KEYS: ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','AD','AE','AF','AG','AH','AI'], openWorkbook, executar, calcular, gerarXlsx, lerReferencia, lerCriticoSheet, DEFAULT_CFG, toISODate };
})(typeof window !== 'undefined' ? window : globalThis);
