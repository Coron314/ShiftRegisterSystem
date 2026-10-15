-- シフト自動作成システム：データベース初期設定
-- Supabase の SQL Editor に全文を貼り付けて「Run」で一度だけ実行する。

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

-- LINEアカウントとスタッフの対応（メンバー用入力画面で本人が自分の名前を選んだ結果）
create table if not exists public.line_links (
  line_user_id text primary key,
  staff_id text not null,
  display_name text,
  updated_at timestamptz not null default now()
);

-- 行単位のアクセス制御：ログインしたリーダーのみ読み書きできる。
-- メンバー（LINEから入力する人）は Edge Function「member-api」経由でのみ、自分の分を読み書きする。
alter table public.app_state enable row level security;
alter table public.availability enable row level security;
alter table public.line_links enable row level security;

drop policy if exists "leader all" on public.app_state;
create policy "leader all" on public.app_state for all to authenticated using (true) with check (true);

drop policy if exists "leader all" on public.availability;
create policy "leader all" on public.availability for all to authenticated using (true) with check (true);

drop policy if exists "leader read" on public.line_links;
create policy "leader read" on public.line_links for select to authenticated using (true);

-- 無料プランの自動一時停止を防ぐため、GitHub Actions から定期的に呼び出す軽い関数
create or replace function public.ping()
returns text
language sql
security definer
set search_path = ''
as $$ select 'ok'::text $$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon;

-- 完成シフトの画像を置く場所（LINEに送るため、URLを知っていれば誰でも見られる公開設定）
insert into storage.buckets (id, name, public)
values ('shift-images', 'shift-images', true)
on conflict (id) do nothing;

drop policy if exists "leader upload shift images" on storage.objects;
create policy "leader upload shift images" on storage.objects
  for insert to authenticated with check (bucket_id = 'shift-images');
