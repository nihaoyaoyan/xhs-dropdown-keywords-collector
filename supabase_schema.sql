-- 小红书下拉词采集器 —— Supabase 历史云同步表结构
-- 在 Supabase Dashboard → SQL Editor 粘贴运行

create table if not exists public.history (
  id text primary key,
  ts bigint not null,
  kind text,
  title text,
  detail text,
  payload jsonb,
  user_id uuid default auth.uid() not null,
  created_at timestamptz default now()
);

-- 行级安全：用户只能读写自己的记录
alter table public.history enable row level security;

drop policy if exists "history_select_own" on public.history;
create policy "history_select_own" on public.history
  for select using (auth.uid() = user_id);

drop policy if exists "history_insert_own" on public.history;
create policy "history_insert_own" on public.history
  for insert with check (auth.uid() = user_id);

drop policy if exists "history_update_own" on public.history;
create policy "history_update_own" on public.history
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "history_delete_own" on public.history;
create policy "history_delete_own" on public.history
  for delete using (auth.uid() = user_id);

-- 索引
create index if not exists history_user_ts_idx on public.history (user_id, ts desc);
