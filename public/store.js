// Camada de armazenamento sobre o Supabase.
// Mantém a mesma interface que a página usava (db.doc/collection, assets, downloads),
// guardando documentos na tabela public.docs e arquivos JSON no bucket "arquivos".
(function () {
  const BUCKET = 'arquivos';
  const DOMINIO = '@armazemdacerveja.com.br';

  function cliente() {
    const cfg = window.CRITICO_CONFIG || {};
    const falta = [!cfg.supabaseUrl && 'SUPABASE_URL', !cfg.supabaseAnonKey && 'SUPABASE_ANON_KEY'].filter(Boolean);
    if (falta.length) throw new Error('O site ainda não foi configurado: falta ' + falta.join(' e ') + ' nas variáveis de ambiente da Vercel (Production). Depois de salvar, faça um Redeploy.');
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  }
  const sb = (() => { try { return cliente(); } catch (e) { return { erro: e }; } })();

  function falha(error) { const e = new Error(error.message || String(error)); e.code = error.code; return e; }
  function partes(path) { const i = path.indexOf('/'); return [path.slice(0, i), path.slice(i + 1)]; }

  function doc(path) {
    const [colecao, id] = partes(path);
    return {
      async get() {
        const { data, error } = await sb.from('docs').select('data').eq('colecao', colecao).eq('id', id).maybeSingle();
        if (error) throw falha(error);
        return { exists: !!data, id, data: () => (data ? data.data : undefined) };
      },
      async set(obj) {
        const { error } = await sb.from('docs').upsert({ colecao, id, data: obj }, { onConflict: 'colecao,id' });
        if (error) throw falha(error);
      },
      async delete() {
        const { error } = await sb.from('docs').delete().eq('colecao', colecao).eq('id', id);
        if (error) throw falha(error);
      }
    };
  }

  function collection(colecao) {
    const q = { ordem: null, dir: 'asc', lim: 1000 };
    const api = {
      orderBy(campo, dir) { q.ordem = campo; q.dir = dir || 'asc'; return api; },
      limit(n) { q.lim = n; return api; },
      async get() {
        const docs = [];
        const passo = 1000;
        for (let de = 0; de < q.lim; de += passo) {
          let r = sb.from('docs').select('id,data').eq('colecao', colecao);
          r = q.ordem ? r.order('data->>' + q.ordem, { ascending: q.dir !== 'desc' }) : r.order('id');
          const ate = Math.min(q.lim, de + passo) - 1;
          const { data, error } = await r.range(de, ate);
          if (error) throw falha(error);
          for (const d of data) docs.push({ id: d.id, data: () => d.data });
          if (data.length < ate - de + 1) break;
        }
        return { docs };
      }
    };
    return api;
  }

  // Os arquivos ficam como <id>.<ext> no bucket. JSON por padrão; os consolidados do mês usam .json.gz.
  const novoId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const assets = {
    async upload(blob, opts) {
      const id = novoId(), ext = (opts && opts.ext) || 'json';
      const { error } = await sb.storage.from(BUCKET).upload(id + '.' + ext, blob, { contentType: (opts && opts.type) || 'application/json', upsert: false });
      if (error) throw falha(error);
      return { id };
    },
    async fetchBytes(id, ext) {
      const { data, error } = await sb.storage.from(BUCKET).download(id + '.' + (ext || 'json'));
      if (error) throw new Error('não consegui ler um arquivo salvo (' + (error.message || error) + ')');
      return new Uint8Array(await data.arrayBuffer());
    },
    async fetch(id) {
      const { data, error } = await sb.storage.from(BUCKET).download(id + '.json');
      if (error) throw new Error('não consegui ler um arquivo salvo (' + (error.message || error) + ')');
      return JSON.parse(await data.text());
    },
    async delete(id, ext) {
      const { error } = await sb.storage.from(BUCKET).remove([id + '.' + (ext || 'json')]);
      if (error) throw falha(error);
    }
  };

  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  };

  const auth = {
    erro: sb.erro || null,
    dominio: DOMINIO,
    async sessao() { if (sb.erro) return null; const { data } = await sb.auth.getSession(); return data.session; },
    async papel() { const { data, error } = await sb.rpc('meu_papel'); if (error) throw falha(error); return data; },
    async entrar(email) {
      email = String(email || '').trim().toLowerCase();
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw falha(error);
    },
    async sair() { await sb.auth.signOut(); location.reload(); },
    aoMudar(fn) { if (!sb.erro) sb.auth.onAuthStateChange((ev, s) => fn(ev, s)); }
  };

  window.CriticoStore = { db: { doc, collection }, assets, downloads, auth };
})();
