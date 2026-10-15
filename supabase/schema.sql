-- シフト自動作成システム：データベース初期設定
-- Supabase の SQL Editor に全文を貼り付けて「Run」で実行する（何度実行しても同じ状態になる）。

-- スタッフ・設定・生成済みシフトなど（シフト希望以外の全データ）を1行のJSONで保存する
create table if not exists public.app_state (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- シフト希望（1人×1日 = 1行）。cell は { mark: "○" | "×", start, end, wish }
create table if not exists public.availability (
  staff_id text not null,
  date text not null,          -- "YYYY-MM-DD"
  cell jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (staff_id, date)
);

-- ログインは行わない。全員が同じ表（シフト希望登録画面）から自分の行に入力するため、
-- 画面（公開キー）から誰でも読み書きできるようにする。
alter table public.app_state enable row level security;
alter table public.availability enable row level security;
grant select, insert, update, delete on public.app_state, public.availability to anon, authenticated;

drop policy if exists "leader all" on public.app_state;
drop policy if exists "everyone all" on public.app_state;
create policy "everyone all" on public.app_state for all to anon, authenticated using (true) with check (true);

drop policy if exists "leader all" on public.availability;
drop policy if exists "everyone all" on public.availability;
create policy "everyone all" on public.availability for all to anon, authenticated using (true) with check (true);

-- 管理用パスワード（4桁。誤操作防止用）。画面からは直接読めないようにし、下の関数でのみ照合・変更する。
create table if not exists public.admin_settings (
  id integer primary key default 1 check (id = 1),
  password text not null default '0507',
  updated_at timestamptz not null default now()
);
insert into public.admin_settings (id) values (1) on conflict (id) do nothing;
alter table public.admin_settings enable row level security;
revoke all on public.admin_settings from anon, authenticated;

create or replace function public.check_admin_password(input_password text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admin_settings where id = 1 and password = input_password)
$$;

-- 現在のパスワードが合っていて、新しいパスワードが4桁の数字のときだけ変更する（変更できたら true）
create or replace function public.change_admin_password(current_password text, new_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new_password !~ '^[0-9]{4}$' then
    return false;
  end if;
  update public.admin_settings
     set password = new_password, updated_at = now()
   where id = 1 and password = current_password;
  return found;
end
$$;

revoke all on function public.check_admin_password(text) from public;
revoke all on function public.change_admin_password(text, text) from public;
grant execute on function public.check_admin_password(text) to anon, authenticated;
grant execute on function public.change_admin_password(text, text) to anon, authenticated;

-- 以前のメンバー用入力画面（LINEアカウントとスタッフの紐付け）で使っていた表。廃止したため削除する。
drop table if exists public.line_links;

-- 無料プランの自動一時停止を防ぐため、GitHub Actions から定期的に呼び出す軽い関数
create or replace function public.ping()
returns text
language sql
security definer
set search_path = ''
as $$ select 'ok'::text $$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon;

-- 完成シフトの画像を置く場所（LINEに送るため、URLを知っていれば誰でも見られる公開設定）。
-- 画像の書き込みは、Edge Function「line-send」がパスワードを確認してから発行する署名付きURLでのみ行う。
insert into storage.buckets (id, name, public)
values ('shift-images', 'shift-images', true)
on conflict (id) do nothing;

drop policy if exists "leader upload shift images" on storage.objects;
