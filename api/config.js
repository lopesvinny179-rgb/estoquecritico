// Entrega a URL e a chave anon do Supabase lidas das variáveis de ambiente da Vercel, na hora do acesso.
// Assim o site não depende do passo de build para enxergar as variáveis.
// Aceita nomes com prefixo (ex.: NEXT_PUBLIC_SUPABASE_URL, STORAGE_SUPABASE_URL), como os da integração Supabase da Vercel.
const acha = (...fins) => {
  for (const fim of fins) {
    const v = (process.env[fim] || '').trim(); if (v) return v;
    for (const [k, val] of Object.entries(process.env)) if (k.endsWith('_' + fim) && (val || '').trim()) return val.trim();
  }
  return '';
};

export default function handler(req, res) {
  const cfg = {
    supabaseUrl: acha('SUPABASE_URL'),
    supabaseAnonKey: acha('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY')
  };
  // Diagnóstico sem expor valores: /api/config?diag mostra só o ambiente e os NOMES das variáveis com SUPABASE.
  if (req.query && 'diag' in req.query) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ ambiente: process.env.VERCEL_ENV || null, variaveis: Object.keys(process.env).filter(k => k.includes('SUPABASE')).sort(), urlOk: !!cfg.supabaseUrl, chaveOk: !!cfg.supabaseAnonKey }, null, 2));
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('if (' + JSON.stringify(!!(cfg.supabaseUrl && cfg.supabaseAnonKey)) + ' || !window.CRITICO_CONFIG) window.CRITICO_CONFIG = ' + JSON.stringify(cfg) + ';\n');
}
