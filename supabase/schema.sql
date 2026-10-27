-- Estoque Crítico: banco e arquivos no Supabase.
-- Rode este script inteiro uma vez em Supabase > SQL Editor > New query > Run.
-- Pode rodar de novo sem problema: ele só cria o que ainda não existe.

-- Quem pode entrar ------------------------------------------------------------
-- Qualquer e-mail @armazemdacerveja.com.br entra como editor.
-- Para dar acesso a outro e-mail, ou deixar alguém só leitura, inclua uma linha aqui:
--   insert into public.acesso (email, papel) values ('fulano@gmail.com', 'leitor');
create table if not exists public.acesso (
  email text primary key check (email = lower(email)),
  papel text not null default 'editor' check (papel in ('editor', 'leitor', 'bloqueado'))
);
alter table public.acesso enable row level security;

create or replace function public.meu_papel() returns text
language sql stable security definer set search_path = public as $$
  select case
    when a.papel = 'bloqueado' then null
    when a.papel is not null then a.papel
    when lower(auth.jwt() ->> 'email') like '%@armazemdacerveja.com.br' then 'editor'
  end
  from (select (select papel from public.acesso where email = lower(auth.jwt() ->> 'email')) as papel) a;
$$;
grant execute on function public.meu_papel() to authenticated;

drop policy if exists "ver o próprio acesso" on public.acesso;
create policy "ver o próprio acesso" on public.acesso for select to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

-- Documentos (estado, execuções, anotações, pontos da reunião) --------------------
create table if not exists public.docs (
  colecao text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now(),
  atualizado_por text,
  primary key (colecao, id)
);
alter table public.docs enable row level security;

create or replace function public.docs_carimbo() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.jwt() ->> 'email';
  return new;
end $$;
drop trigger if exists docs_carimbo on public.docs;
create trigger docs_carimbo before insert or update on public.docs
  for each row execute function public.docs_carimbo();

drop policy if exists "ler docs" on public.docs;
create policy "ler docs" on public.docs for select to authenticated
  using (public.meu_papel() is not null);
drop policy if exists "gravar docs" on public.docs;
create policy "gravar docs" on public.docs for insert to authenticated
  with check (public.meu_papel() = 'editor');
drop policy if exists "alterar docs" on public.docs;
create policy "alterar docs" on public.docs for update to authenticated
  using (public.meu_papel() = 'editor') with check (public.meu_papel() = 'editor');
drop policy if exists "apagar docs" on public.docs;
create policy "apagar docs" on public.docs for delete to authenticated
  using (public.meu_papel() = 'editor');

-- Arquivos (De-para, Top 20 e cada crítico salvo, em JSON) -------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('arquivos', 'arquivos', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "ler arquivos" on storage.objects;
create policy "ler arquivos" on storage.objects for select to authenticated
  using (bucket_id = 'arquivos' and public.meu_papel() is not null);
drop policy if exists "gravar arquivos" on storage.objects;
create policy "gravar arquivos" on storage.objects for insert to authenticated
  with check (bucket_id = 'arquivos' and public.meu_papel() = 'editor');
drop policy if exists "apagar arquivos" on storage.objects;
create policy "apagar arquivos" on storage.objects for delete to authenticated
  using (bucket_id = 'arquivos' and public.meu_papel() = 'editor');
