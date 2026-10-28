// Entrega a URL e a chave anon do Supabase lidas das variáveis de ambiente da Vercel, na hora do acesso.
// Assim o site não depende do passo de build para enxergar as variáveis.
const pega = (...nomes) => { for (const n of nomes) { const v = (process.env[n] || '').trim(); if (v) return v; } return ''; };

export default function handler(req, res) {
  const cfg = {
    supabaseUrl: pega('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL'),
    supabaseAnonKey: pega('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('if (' + JSON.stringify(!!(cfg.supabaseUrl && cfg.supabaseAnonKey)) + ' || !window.CRITICO_CONFIG) window.CRITICO_CONFIG = ' + JSON.stringify(cfg) + ';\n');
}
