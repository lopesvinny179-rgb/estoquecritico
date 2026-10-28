// Monta o site em dist/: copia public/ e escreve config.js a partir das variáveis de ambiente da Vercel.
// Nenhuma chave fica no repositório.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const pega = (...nomes) => { for (const n of nomes) { const v = (process.env[n] || '').trim(); if (v) return v; } return ''; };
const url = pega('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL');
const key = pega('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
if (!url || !key) console.warn('Aviso: SUPABASE_URL ou SUPABASE_ANON_KEY não definidos. O site vai abrir pedindo configuração.');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('public', 'dist', { recursive: true });
writeFileSync('dist/config.js', 'window.CRITICO_CONFIG = ' + JSON.stringify({ supabaseUrl: url, supabaseAnonKey: key }) + ';\n');
console.log('dist/ pronto.');
