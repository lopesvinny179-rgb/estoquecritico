# Estoque Crítico

Site do Estoque Crítico de Compras. Você sobe a Posição de Estoque, a Base Margem do mês anterior e as Compras FWI, clica em **Executar** e recebe o crítico do dia com as mesmas colunas e fórmulas da aba `Criticos_estoque`, além das anotações da reunião.

Todo o cálculo roda no navegador de quem usa. Os arquivos de origem não saem do computador. O que fica salvo (De-para, Top 20, críticos anteriores, anotações e pontos da reunião) vai para um projeto **Supabase** privado, protegido por login. **Este repositório é público e não guarda nenhum dado nem chave.**

## Como está montado

| Parte | Onde |
| --- | --- |
| Tela | `public/index.html` |
| Motor (leitura dos xlsx, dinâmicas, fórmulas, geração do xlsx) | `public/engine.js` |
| Banco, arquivos e login | `public/store.js` (Supabase) |
| Tabelas e regras de acesso | `supabase/schema.sql` |
| Build da Vercel | `build.mjs` gera `dist/` e o `config.js` a partir das variáveis de ambiente |

## Colocar no ar

1. **Supabase** (supabase.com, plano gratuito): crie um projeto. Em *SQL Editor*, cole e rode `supabase/schema.sql`.
2. Em *Authentication > URL Configuration*, coloque o endereço do site (por exemplo `https://estoquecritico.vercel.app`) em *Site URL* e em *Redirect URLs*.
3. Em *Project Settings > API*, copie a **Project URL** e a chave **anon public**.
4. **Vercel** (vercel.com, entre com o GitHub): *Add New > Project*, escolha este repositório. Em *Environment Variables* crie `SUPABASE_URL` e `SUPABASE_ANON_KEY` com os valores do passo 3. Clique em *Deploy*.
5. Abra o site, entre com o seu e-mail da empresa e, em *Referências fixas > Backup*, restaure o backup com os dados atuais.

A chave *anon public* é feita para ficar no navegador: quem protege os dados são as regras do `schema.sql`. Nunca use a chave *service_role* no site.

## Quem tem acesso

- Qualquer e-mail `@armazemdacerveja.com.br` entra como editor, com um link mágico enviado por e-mail.
- Para liberar outro e-mail, deixar alguém só leitura ou bloquear alguém, use a tabela `acesso` no Supabase:

```sql
insert into public.acesso (email, papel) values ('fulano@gmail.com', 'leitor');   -- editor | leitor | bloqueado
```

O envio de e-mail padrão do Supabase tem limite baixo por hora. Para uma equipe grande, configure um SMTP próprio em *Authentication > SMTP* ou ative login com Google/Microsoft.

## Rodar localmente

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run dev
```
